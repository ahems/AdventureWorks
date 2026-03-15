import React from 'react';
import { Link } from 'react-router-dom';
import { 
  Mic, 
  Brain, 
  Bot, 
  Sparkles, 
  ArrowRight, 
  MessageSquare, 
  BarChart3, 
  Mail, 
  Target, 
  Zap,
  Volume2,
  Search,
  TrendingUp,
  Users,
  ShoppingCart,
  CheckCircle
} from 'lucide-react';
import AdminHeader from '@/components/AdminHeader';
import Footer from '@/components/Footer';
import { useVoiceAssistant } from '@/components/AdminHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  capabilities: string[];
  demoAction?: () => void;
  demoLabel?: string;
  linkTo?: string;
  linkLabel?: string;
  badge?: string;
}

const FeatureCard: React.FC<FeatureCardProps> = ({
  icon,
  title,
  description,
  capabilities,
  demoAction,
  demoLabel,
  linkTo,
  linkLabel,
  badge
}) => (
  <div className="doodle-card p-6 md:p-8 h-full flex flex-col">
    <div className="flex items-start justify-between mb-4">
      <div className="w-14 h-14 rounded-lg bg-doodle-accent/10 border-2 border-doodle-text flex items-center justify-center">
        {icon}
      </div>
      {badge && (
        <Badge className="bg-doodle-green text-white border-2 border-doodle-text font-doodle">
          {badge}
        </Badge>
      )}
    </div>
    
    <h3 className="font-doodle text-xl font-bold text-doodle-text mb-2">{title}</h3>
    <p className="font-doodle text-doodle-text/70 mb-4 flex-grow">{description}</p>
    
    <div className="space-y-2 mb-6">
      <p className="font-doodle text-sm font-bold text-doodle-text/80">Capabilities:</p>
      <ul className="space-y-1">
        {capabilities.map((cap, i) => (
          <li key={i} className="flex items-center gap-2 font-doodle text-sm text-doodle-text/70">
            <CheckCircle className="w-4 h-4 text-doodle-green shrink-0" />
            {cap}
          </li>
        ))}
      </ul>
    </div>
    
    <div className="flex flex-wrap gap-2 mt-auto">
      {demoAction && (
        <Button 
          onClick={demoAction}
          className="doodle-button doodle-button-primary flex items-center gap-2"
        >
          <Zap className="w-4 h-4" />
          {demoLabel || 'Try Demo'}
        </Button>
      )}
      {linkTo && (
        <Link to={linkTo}>
          <Button variant="outline" className="doodle-button flex items-center gap-2">
            {linkLabel || 'Learn More'}
            <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      )}
    </div>
  </div>
);

const SampleQueryCard: React.FC<{ query: string; category: string; icon: React.ReactNode }> = ({ query, category, icon }) => (
  <div className="p-4 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors bg-doodle-bg/50">
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <span className="font-doodle text-xs text-doodle-text/50 uppercase">{category}</span>
    </div>
    <p className="font-doodle text-sm text-doodle-text">"{query}"</p>
  </div>
);

const AiFeaturesPage: React.FC = () => {
  const voiceContext = React.useContext(
    React.createContext<{ isVoiceOpen: boolean; setIsVoiceOpen: React.Dispatch<React.SetStateAction<boolean>> } | null>(null)
  );
  
  // Safe way to access voice context
  const openVoiceAssistant = () => {
    try {
      const { setIsVoiceOpen } = useVoiceAssistant();
      setIsVoiceOpen(true);
    } catch {
      // Fallback if context not available
      console.log('Voice assistant demo triggered');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-doodle-bg">
      <AdminHeader />
      
      <main className="flex-1">
        {/* Hero Section */}
        <section className="container mx-auto px-4 py-12">
          <div className="doodle-card p-8 md:p-12 text-center bg-gradient-to-br from-doodle-accent/5 to-doodle-green/5">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-doodle-accent/20 border-3 border-doodle-text flex items-center justify-center">
                <Sparkles className="w-10 h-10 text-doodle-accent" />
              </div>
            </div>
            <h1 className="font-doodle text-3xl md:text-5xl font-bold text-doodle-text mb-4">
              AI-Powered Features
            </h1>
            <p className="font-doodle text-lg text-doodle-text/70 max-w-2xl mx-auto mb-6">
              Experience the future of e-commerce management with our intelligent AI assistants. 
              Voice commands, natural language queries, and automated recovery strategies.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Badge className="bg-doodle-accent text-white border-2 border-doodle-text font-doodle text-sm px-3 py-1">
                🎤 Voice Enabled
              </Badge>
              <Badge className="bg-doodle-green text-white border-2 border-doodle-text font-doodle text-sm px-3 py-1">
                📊 Natural Language
              </Badge>
              <Badge className="bg-doodle-blue text-white border-2 border-doodle-text font-doodle text-sm px-3 py-1">
                🤖 AI Automation
              </Badge>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="container mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Voice Sales Assistant */}
            <FeatureCard
              icon={<Mic className="w-7 h-7 text-doodle-accent" />}
              title="Voice Sales Assistant"
              description="Hands-free access to your business data. Ask questions naturally and get instant spoken responses about customers, orders, and products."
              capabilities={[
                "Voice-activated queries",
                "Customer lookup by ID or name",
                "Real-time order status checks",
                "Product information retrieval",
                "Sales performance summaries"
              ]}
              demoAction={() => {
                // Trigger via header button
                const btn = document.querySelector('[aria-label="Toggle Voice Assistant"]') as HTMLButtonElement;
                if (btn) btn.click();
              }}
              demoLabel="Open Voice Assistant"
              badge="Voice AI"
            />

            {/* Natural Language BI */}
            <FeatureCard
              icon={<Brain className="w-7 h-7 text-doodle-green" />}
              title="Natural Language BI"
              description="Ask business questions in plain English and get instant visualizations. No SQL required—just type your question and see the results."
              capabilities={[
                "Plain English queries",
                "Auto-generated charts & graphs",
                "Customer analytics",
                "Revenue breakdowns",
                "Order trend analysis"
              ]}
              linkTo="/"
              linkLabel="Go to Dashboard"
              badge="Analytics"
            />

            {/* Cart Recovery Agent */}
            <FeatureCard
              icon={<Bot className="w-7 h-7 text-doodle-blue" />}
              title="Smart Cart Recovery"
              description="AI-powered abandoned cart analysis with personalized recovery strategies. Automatically prioritizes carts and generates targeted outreach."
              capabilities={[
                "Recovery likelihood scoring",
                "Personalized email generation",
                "Campaign simulation",
                "Automatic prioritization",
                "One-click outreach"
              ]}
              linkTo="/stale-carts"
              linkLabel="View Stale Carts"
              badge="Automation"
            />
          </div>
        </section>

        {/* Sample Queries Section */}
        <section className="container mx-auto px-4 pb-12">
          <div className="doodle-card p-6 md:p-8">
            <div className="flex items-center gap-3 mb-6">
              <MessageSquare className="w-6 h-6 text-doodle-accent" />
              <h2 className="font-doodle text-2xl font-bold text-doodle-text">Sample AI Queries</h2>
            </div>
            <p className="font-doodle text-doodle-text/70 mb-6">
              Try these example queries with our Voice Assistant or Natural Language BI:
            </p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SampleQueryCard 
                query="Who are my top 5 customers by revenue?"
                category="Customers"
                icon={<Users className="w-4 h-4 text-doodle-green" />}
              />
              <SampleQueryCard 
                query="What's the status of order 70003?"
                category="Orders"
                icon={<ShoppingCart className="w-4 h-4 text-doodle-blue" />}
              />
              <SampleQueryCard 
                query="Show me revenue breakdown by state"
                category="Analytics"
                icon={<BarChart3 className="w-4 h-4 text-doodle-accent" />}
              />
              <SampleQueryCard 
                query="Tell me about the Road-150 bike"
                category="Products"
                icon={<Search className="w-4 h-4 text-doodle-text" />}
              />
              <SampleQueryCard 
                query="How are sales looking this month?"
                category="Performance"
                icon={<TrendingUp className="w-4 h-4 text-doodle-green" />}
              />
              <SampleQueryCard 
                query="What orders are pending?"
                category="Operations"
                icon={<Target className="w-4 h-4 text-doodle-accent" />}
              />
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="container mx-auto px-4 pb-12">
          <div className="doodle-card p-6 md:p-8">
            <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-6 text-center">
              How It Works
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-doodle-accent/20 border-3 border-doodle-text flex items-center justify-center mx-auto mb-4">
                  <span className="font-doodle text-2xl font-bold text-doodle-accent">1</span>
                </div>
                <h3 className="font-doodle font-bold text-doodle-text mb-2">Ask Naturally</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Use voice or text to ask questions in plain English. No technical knowledge required.
                </p>
              </div>
              
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-doodle-green/20 border-3 border-doodle-text flex items-center justify-center mx-auto mb-4">
                  <span className="font-doodle text-2xl font-bold text-doodle-green">2</span>
                </div>
                <h3 className="font-doodle font-bold text-doodle-text mb-2">AI Processes</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Our AI understands your intent and queries the relevant data from your business systems.
                </p>
              </div>
              
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-doodle-blue/20 border-3 border-doodle-text flex items-center justify-center mx-auto mb-4">
                  <span className="font-doodle text-2xl font-bold text-doodle-blue">3</span>
                </div>
                <h3 className="font-doodle font-bold text-doodle-text mb-2">Get Insights</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Receive instant answers, visualizations, and actionable recommendations.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="container mx-auto px-4 pb-12">
          <div className="doodle-card p-8 text-center bg-doodle-accent/10">
            <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-4">
              Ready to Experience AI-Powered Management?
            </h2>
            <p className="font-doodle text-doodle-text/70 mb-6 max-w-lg mx-auto">
              Start using voice commands and natural language queries to supercharge your workflow.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Button 
                onClick={() => {
                  const btn = document.querySelector('[aria-label="Toggle Voice Assistant"]') as HTMLButtonElement;
                  if (btn) btn.click();
                }}
                className="doodle-button doodle-button-primary flex items-center gap-2"
              >
                <Mic className="w-5 h-5" />
                Try Voice Assistant
              </Button>
              <Link to="/">
                <Button variant="outline" className="doodle-button flex items-center gap-2">
                  <Brain className="w-5 h-5" />
                  Explore BI Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default AiFeaturesPage;
