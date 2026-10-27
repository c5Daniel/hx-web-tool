# HX Web Tool

Hestia NTN Dongle 的瀏覽器版 Host 工具——把 `ttool/`（Python CLI）的核心流程搬到網頁上，
用 Web Serial 直接對裝置的 Host Modbus 埠說話。不用裝 Python、不用打指令：開網頁、選 COM 埠、按按鈕。

另有一個**藍牙狀態頁**：在現場用手機透過 Web Bluetooth 就近讀取裝置狀態（唯讀、需配對），
不需要序列埠，也不需要網路（見下方「離線／安裝」）。

兩個是**分開的網址**，彼此看不到對方：

| 網址 | 內容 |
|---|---|
| `https://<部署網址>/` | Modbus 工具（序列埠） |
| `https://<部署網址>/ble/` | 藍牙狀態頁（手機、裝置標籤的 QR code） |

舊的 `https://<部署網址>/#ble` 會自動轉到 `/ble/`。

與 [`hestia-web-tool`](https://github.com/CREATIVE5-io/hestia-web-tool) 同一套技術與風格
（Vite + React + TypeScript + Tailwind，靜態部署到 GitHub Pages）。

## 使用

- 瀏覽器：**Chrome 或 Edge**（Web Serial）。網址必須是 `https://` 或 `localhost`。
- 接上裝置的 Host 埠（DK 上是第二個 debugger VCOM），按「連線」選埠。
- 預設 115200 / 站號 1 / 密碼 8 個 `0x00`。每個操作都會先自動登入（與 ttool 相同），
  需要工程模式的操作會自動開啟。
- 同一個 COM 埠一次只能被一個程式打開：用網頁時先關掉 ttool、終端機或其他分頁。
- 按「中斷連線」或線被拔掉時，各分頁讀到的結果和欄位全部清空，回到剛開網頁的樣子；
  連線設定（鮑率、站號、密碼）和下方的通訊紀錄會保留。

| 分頁 | 對應 ttool |
|---|---|
| 儀表板 | `read 0xEA60 30` + `read 0xEB00 51`，並解碼 0xEA71 狀態位元、重啟原因、LoRa 就緒 |
| 上下行 | `ul` / `ulres --wait` / `dl` / `watch` / `ntn-at "AT…"` / `ntn-at --poll`（NTN 模組 AT，`0x9C40` → `0x9C41`/`0x9C42`） |
| 設定 | `netcfg [--reset]` / `actmode [--verify-reject]` / `baud` / `debug-console` / `ble [off\|on\|always]` / `set-password` |
| LoRa | `lora "AT…" --read` / `lora --poll` / `--poll-reply` / `lora --status` / `lora-interval` |
| 透傳 | `passthrough enter/exit/fwver/term`（終端機在瀏覽器內） |
| 工廠 | `provision [--ble-passkey]` / `ble-passkey` / `set-id` / `assign-id` / `reset` / `factory-reset [--wipe-identity]` |
| 工具 | 任意 FC 0x03/0x04 讀取（`dlcmd-encode` 卡片暫時隱藏，程式與測試保留：`ToolsPanel.tsx` 的 `SHOW_DLCMD_CARD`） |

工廠分頁另有「藍牙配對 passkey (0xFFD3)」：讀取／寫入標籤上的 6 位數 passkey（對應 ttool `ble-passkey`，
需要工程模式，會自動開啟）；出廠佈建也可一併寫入 passkey（對應 `provision --ble-passkey`，記進生產紀錄）。
設定分頁的「藍牙開關 (0xFFD5)」對應 ttool `ble`：裝置每次開機只廣播 10 分鐘，沒有手機配對就停止，
這裡可以重新開放 10 分鐘、開到下次開機不倒數，或立即關閉（只需登入，不持久化）。

**v1 不含**：`ota` / `dfu` / `bus-mute`（需要瀏覽器端的 mcumgr SMP，排在下一階段；目前請用 ttool）。

## 藍牙狀態頁（手機）

- 網址是 `https://<部署網址>/ble/`（裝置標籤上的 QR code 指向這裡）。舊的 `/#ble` 會自動轉過來。
- 裝置開機後只廣播 10 分鐘；清單裡找不到時，把裝置斷電重開，或請 Host 打開藍牙（`0xFFD5`）。
- **Android**：用 Chrome（或 Edge）。按「連線裝置」，選名稱 `HX-` 開頭的裝置。
- **第一次連線**手機會跳出系統配對視窗，輸入**裝置標籤上的 6 位數 passkey**；之後同一支手機會自動沿用配對。
- 配對失敗或取消：按「重新連線」再試。裝置做過出廠重置（兩級都會刪除所有藍牙配對）或換過 passkey 時，
  請先到 Android「設定 → 藍牙」把該裝置**取消配對／忘記**，再重新連線。
- **一直連線失敗**（重新連線好幾次都不行）：到手機的「設定 → 藍牙」把這台 `HX-…`
  **取消配對／忘記**，再回網頁重新連線並輸入 passkey。手機和裝置記得的配對資料對不上時，只能這樣重來。
- **iPhone／iPad**：Safari 和 iOS 上的其他瀏覽器都不支援 Web Bluetooth，請改用 **Bluefy** 瀏覽器開啟。
- 電腦：Chrome 或 Edge。網址必須是 `https://` 或 `localhost`。
- 顯示內容：衛星連線階段（0xEA71 各位元的白話說明，與儀表板用詞相同）、RSRP／SINR／訊號分級與讀數時間、
  上行通道、工作模式、主動模式、LoRa 就緒、上次重啟原因、運作時間、模組時間（轉成本地時間）、序號等裝置資訊。
- 裝置有變化時會通知網頁重讀；另每 5 秒自動更新一次（運作時間、模組時間、讀數時間）。
- 斷線後讀到的狀態全部清空，不會留著舊資料。自己按「中斷連線」會完全回到剛開網頁的樣子；
  意外斷線（走太遠、裝置重開）則保留錯誤說明和「重新連線」按鈕。
- 協定以韌體 repo 的 `docs/BLE_STATUS_SERVICE.md` 為準。

## 離線／安裝（PWA）

現場通常沒有網路。只要**有網路時開過一次**本頁，之後就能離線開啟：

- Android Chrome：選單 →「安裝應用程式」／「加到主畫面」；電腦 Chrome／Edge：網址列的安裝圖示。
- 兩個網址各自安裝成**兩個 App**：在 `/ble/` 安裝的是「HX 藍牙狀態」，點開就是藍牙頁；在 `/` 安裝的是 Modbus 工具。
- 離線時兩頁都能開啟：藍牙頁照常使用（藍牙本身不需要網路），序列埠功能也照常可用。
- 有網路時會自動抓最新版（下次開啟生效）。
- 只有 `npm run build` 產生的正式版會註冊 service worker；`npm run dev` 不會。

## 開發

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest：CRC/frame（USER_MANUAL 範例位元組）、dlcmd 參考 frame、編碼器、BLE 解碼、passkey 流程
npm run build    # tsc + vite build -> dist/
node scripts/gen-icons.mjs   # 重新產生 PWA 圖示（只在改圖時需要；PNG 已進版控）
```

推到 `main` 會由 `.github/workflows/deploy.yml` 建置並部署到 GitHub Pages（`base: './'`，任何 repo 名都可）。

## 結構

```
utils/serialTransport.ts  Web Serial 埠 + 背景讀取緩衝（唯一碰到埠的地方）
utils/modbusRtu.ts        Modbus RTU master（移植 ttool/modbus_rtu.py）
utils/ntnCodec.ts         暫存器打包與多步流程（移植 ttool/ntn_codec.py）
utils/registers.ts        位址、欄位表、解碼
utils/ops/*.ts            ttool 各 cmd_* 流程，純 async 函式，不依賴 React
utils/bleTransport.ts     Web Bluetooth（唯一碰到 navigator.bluetooth 的地方）
utils/bleStatus.ts        BLE 狀態／識別 characteristic 解碼（純 TS）
hooks/useGateway.ts       序列埠連線、log、session 狀態、一次跑一個操作
hooks/useBleStatus.ts     藍牙連線與最新快照（與 useGateway 互不相干）
components/               UI；panels/ 一個分頁一個檔案（BlePanel = 藍牙狀態頁）
i18n/                     繁中（預設）／英文字典
public/                   sw.js（離線快取）、manifest.webmanifest、icons/
scripts/gen-icons.mjs     產生 PWA 圖示（只用 Node 內建模組）
tests/                    vitest + 模擬裝置（tests/mockLink.ts）
```

暫存器定義以韌體 repo 的 `docs/NTN_MODBUS_SPEC.md` 為準；行為以 `ttool/` 為準——兩邊有出入時先改 ttool 的行為描述，再同步這裡。
