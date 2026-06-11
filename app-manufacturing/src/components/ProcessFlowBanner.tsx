import { Link } from 'react-router-dom';
import { ClipboardList, Cog, Calendar, Play, PackageCheck, ArrowRight } from 'lucide-react';

const stages = [
  { stage: 1, label: 'Define', desc: 'Product catalog & specs', icon: ClipboardList, to: '/define', color: 'text-doodle-accent' },
  { stage: 2, label: 'Engineer', desc: 'BOM & routing', icon: Cog, to: '/engineer', color: 'text-doodle-blue' },
  { stage: 3, label: 'Plan', desc: 'Work orders & scheduling', icon: Calendar, to: '/plan', color: 'text-doodle-green' },
  { stage: 4, label: 'Execute', desc: 'Shop floor tracking', icon: Play, to: '/execute', color: 'text-primary' },
  { stage: 5, label: 'Receive', desc: 'Inventory & costing', icon: PackageCheck, to: '/receive', color: 'text-doodle-accent' },
];

const ProcessFlowBanner: React.FC = () => {
  return (
    <div className="doodle-card-static p-6">
      <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Manufacturing Lifecycle</h2>
      <div className="flex flex-wrap items-center justify-center gap-2 md:gap-0">
        {stages.map((s, i) => (
          <div key={s.stage} className="flex items-center">
            <Link
              to={s.to}
              className="flex flex-col items-center gap-1 px-3 py-2 hover:bg-secondary/50 rounded transition-colors group"
            >
              <div className={`doodle-border-light p-2 group-hover:rotate-6 transition-transform ${s.color}`}>
                <s.icon className="w-5 h-5" />
              </div>
              <span className="font-doodle text-xs font-bold text-doodle-text">{s.stage}. {s.label}</span>
              <span className="font-doodle text-[10px] text-muted-foreground">{s.desc}</span>
            </Link>
            {i < stages.length - 1 && (
              <ArrowRight className="w-4 h-4 text-doodle-text/30 hidden md:block mx-1" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProcessFlowBanner;
