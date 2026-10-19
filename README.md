# HX Web Tool

Hestia NTN Dongle 的瀏覽器版 Host 工具——把 `ttool/`（Python CLI）的核心流程搬到網頁上，
用 Web Serial 直接對裝置的 Host Modbus 埠說話。不用裝 Python、不用打指令：開網頁、選 COM 埠、按按鈕。

與 [`hestia-web-tool`](https://github.com/CREATIVE5-io/hestia-web-tool) 同一套技術與風格
（Vite + React + TypeScript + Tailwind，靜態部署到 GitHub Pages）。

## 使用

- 瀏覽器：**Chrome 或 Edge**（Web Serial）。網址必須是 `https://` 或 `localhost`。
- 接上裝置的 Host 埠（DK 上是第二個 debugger VCOM），按「連線」選埠。
- 預設 115200 / 站號 1 / 密碼 8 個 `0x00`。每個操作都會先自動登入（與 ttool 相同），
  需要工程模式的操作會自動開啟。
- 同一個 COM 埠一次只能被一個程式打開：用網頁時先關掉 ttool、終端機或其他分頁。

| 分頁 | 對應 ttool |
|---|---|
| 儀表板 | `read 0xEA60 30` + `read 0xEB00 51`，並解碼 0xEA71 狀態位元、重啟原因、LoRa 就緒 |
| 上下行 | `ul` / `ulres --wait` / `dl` / `watch` |
| 設定 | `netcfg [--reset]` / `actmode [--verify-reject]` / `baud` / `debug-console` / `set-password` |
| LoRa | `lora "AT…" --read` / `lora --poll` / `--poll-reply` / `lora --status` / `lora-interval` |
| 透傳 | `passthrough enter/exit/fwver/term`（終端機在瀏覽器內） |
| 工廠 | `provision` / `set-id` / `assign-id` / `reset` / `factory-reset [--wipe-identity]` |
| 工具 | 任意 FC 0x03/0x04 讀取、`dlcmd-encode`（離線，含 self-test） |

**v1 不含**：`ota` / `dfu` / `bus-mute`（需要瀏覽器端的 mcumgr SMP，排在下一階段；目前請用 ttool）。

## 開發

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest：CRC/frame（USER_MANUAL 範例位元組）、dlcmd 參考 frame、編碼器
npm run build    # tsc + vite build -> dist/
```

推到 `main` 會由 `.github/workflows/deploy.yml` 建置並部署到 GitHub Pages（`base: './'`，任何 repo 名都可）。

## 結構

```
utils/serialTransport.ts  Web Serial 埠 + 背景讀取緩衝（唯一碰到埠的地方）
utils/modbusRtu.ts        Modbus RTU master（移植 ttool/modbus_rtu.py）
utils/ntnCodec.ts         暫存器打包與多步流程（移植 ttool/ntn_codec.py）
utils/registers.ts        位址、欄位表、解碼
utils/ops/*.ts            ttool 各 cmd_* 流程，純 async 函式，不依賴 React
hooks/useGateway.ts       連線、log、session 狀態、一次跑一個操作
components/               UI；panels/ 一個分頁一個檔案
i18n/                     繁中（預設）／英文字典
tests/                    vitest + 模擬裝置（tests/mockLink.ts）
```

暫存器定義以韌體 repo 的 `docs/NTN_MODBUS_SPEC.md` 為準；行為以 `ttool/` 為準——兩邊有出入時先改 ttool 的行為描述，再同步這裡。
