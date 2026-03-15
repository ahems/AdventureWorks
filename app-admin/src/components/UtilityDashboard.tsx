import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { 
  Package, 
  Search, 
  Languages, 
  Image, 
  MessageSquare, 
  Clock, 
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { getUtilityStats, UtilityStats } from '@/services/mockUtilityService';

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
}> = ({ title, value, subtitle, icon }) => (
  <Card className="doodle-card">
    <CardContent className="p-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-sm font-doodle text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold font-doodle">{value}</p>
          {subtitle && (
            <p className="text-xs font-doodle text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
      </div>
    </CardContent>
  </Card>
);

const ExecutionItem: React.FC<{
  name: string;
  time: string;
  status: 'success' | 'failed' | 'running';
}> = ({ name, time, status }) => (
  <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
    <div className="flex items-center gap-2">
      {status === 'success' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
      {status === 'failed' && <AlertCircle className="w-4 h-4 text-red-500" />}
      {status === 'running' && (
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      )}
      <span className="font-doodle text-sm">{name}</span>
    </div>
    <span className="font-doodle text-xs text-muted-foreground">{time}</span>
  </div>
);

const UtilityDashboard: React.FC = () => {
  const stats: UtilityStats = getUtilityStats();

  const formatTime = (isoString: string | null) => {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  return (
    <div className="space-y-6 mb-8">
      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Products"
          value={stats.totalProducts.toLocaleString()}
          subtitle={`${stats.productsWithEmbeddings} with embeddings`}
          icon={<Package className="w-5 h-5" />}
        />
        <StatCard
          title="Embeddings Generated"
          value={stats.totalEmbeddings.toLocaleString()}
          subtitle={`${stats.reviewEmbeddings} review embeddings`}
          icon={<Search className="w-5 h-5" />}
        />
        <StatCard
          title="Translations"
          value={stats.totalTranslations.toLocaleString()}
          subtitle={`${stats.languagesCovered} languages`}
          icon={<Languages className="w-5 h-5" />}
        />
        <StatCard
          title="AI Images"
          value={stats.aiGeneratedImages.toLocaleString()}
          subtitle={`${stats.thumbnailsGenerated} thumbnails`}
          icon={<Image className="w-5 h-5" />}
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="doodle-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-primary" />
              <h3 className="font-doodle font-bold text-sm">Reviews</h3>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">Total Reviews</span>
                <span className="font-doodle font-bold">{stats.totalReviews.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">AI Generated</span>
                <span className="font-doodle font-bold">{stats.aiGeneratedReviews.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">Avg Rating</span>
                <span className="font-doodle font-bold">{stats.averageRating.toFixed(1)} ★</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="doodle-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-primary" />
              <h3 className="font-doodle font-bold text-sm">Last Executions</h3>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">Embeddings</span>
                <span className="font-doodle text-xs">{formatTime(stats.lastExecutions.embeddings)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">Translations</span>
                <span className="font-doodle text-xs">{formatTime(stats.lastExecutions.translations)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-doodle text-sm text-muted-foreground">Image Gen</span>
                <span className="font-doodle text-xs">{formatTime(stats.lastExecutions.imageGeneration)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="doodle-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <h3 className="font-doodle font-bold text-sm">Recent Activity</h3>
            </div>
            <div className="space-y-0">
              {stats.recentExecutions.map((exec, index) => (
                <ExecutionItem
                  key={index}
                  name={exec.name}
                  time={formatTime(exec.time)}
                  status={exec.status}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default UtilityDashboard;
