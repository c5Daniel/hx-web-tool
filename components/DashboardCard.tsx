import React from 'react';

type AccentColor = 'blue' | 'purple' | 'green' | 'cyan' | 'amber' | 'red';

const titleColors: Record<AccentColor, string> = {
  blue: 'text-blue-400',
  purple: 'text-purple-400',
  green: 'text-green-400',
  cyan: 'text-cyan-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
};

interface DashboardCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  accent?: AccentColor;
  /** Right-aligned controls in the title row. */
  actions?: React.ReactNode;
}

export const DashboardCard: React.FC<DashboardCardProps> = ({ title, children, className = '', accent, actions }) => {
  return (
    <div className={`bg-slate-800 rounded-lg border border-slate-700 shadow-sm p-4 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-700/50">
        <h3 className={`text-sm font-semibold tracking-wider ${accent ? titleColors[accent] : 'text-slate-400'}`}>{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
};
