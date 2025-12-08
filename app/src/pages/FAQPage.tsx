import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, HelpCircle, Mail, Phone } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

interface FAQCategory {
  title: string;
  icon: string;
  questions: { question: string; answer: string }[];
}

const faqData: FAQCategory[] = [
  {
    title: 'Orders & Shipping',
    icon: '📦',
    questions: [
      {
        question: 'How long does shipping take?',
        answer: 'Standard shipping typically takes 3-5 business days within the continental US. Expedited shipping (1-2 business days) is available at checkout for an additional fee. International orders may take 7-14 business days depending on the destination.',
      },
      {
        question: 'Do you offer free shipping?',
        answer: 'Yes! We offer free standard shipping on all orders over $75. Orders under $75 have a flat rate shipping fee of $7.99.',
      },
      {
        question: 'Can I change or cancel my order?',
        answer: 'You can modify or cancel your order within 1 hour of placing it. After that, orders enter our fulfillment process and cannot be changed. Please contact us immediately if you need to make changes.',
      },
      {
        question: 'How do I track my order?',
        answer: 'Once your order ships, you\'ll receive a confirmation email with tracking information. You can also track your order anytime by visiting the Order Tracking page in your account.',
      },
    ],
  },
  {
    title: 'Returns & Exchanges',
    icon: '🔄',
    questions: [
      {
        question: 'What is your return policy?',
        answer: 'We offer a 30-day return policy for unused items in original packaging. Bikes must be unassembled and returned within 14 days. See our full Returns Policy page for details.',
      },
      {
        question: 'How do I start a return?',
        answer: 'Contact our support team at returns@adventureworks.com or call (555) 123-4567. We\'ll provide a prepaid shipping label and guide you through the process.',
      },
      {
        question: 'When will I receive my refund?',
        answer: 'Refunds are processed within 5-7 business days after we receive and inspect your return. The refund will be credited to your original payment method.',
      },
      {
        question: 'Can I exchange an item for a different size?',
        answer: 'Absolutely! Exchanges are free. Just mention "exchange" when contacting us and specify the size or color you need. We\'ll ship the new item as soon as we receive your return.',
      },
    ],
  },
  {
    title: 'Products & Sizing',
    icon: '🚴',
    questions: [
      {
        question: 'How do I choose the right bike size?',
        answer: 'Bike sizing depends on your height and inseam length. Generally: 5\'0"-5\'4" = XS/S, 5\'4"-5\'8" = S/M, 5\'8"-6\'0" = M/L, 6\'0"-6\'4" = L/XL. Check the product page for specific sizing charts or contact us for personalized advice.',
      },
      {
        question: 'Are your bikes fully assembled?',
        answer: 'Bikes ship 85% assembled to ensure safe transport. You\'ll need to attach the front wheel, handlebars, pedals, and seat. Basic tools and instructions are included. We also offer professional assembly at select locations.',
      },
      {
        question: 'Do you offer a warranty?',
        answer: 'Yes! All bikes come with a 2-year warranty on frames and a 1-year warranty on components. Accessories and clothing have a 90-day warranty against manufacturing defects.',
      },
      {
        question: 'What if an item is out of stock?',
        answer: 'You can sign up for notifications on the product page to be alerted when it\'s back in stock. Popular items typically restock within 2-4 weeks.',
      },
    ],
  },
  {
    title: 'Account & Payment',
    icon: '💳',
    questions: [
      {
        question: 'What payment methods do you accept?',
        answer: 'We accept all major credit cards (Visa, Mastercard, American Express, Discover), PayPal, Apple Pay, and Google Pay. We also offer financing through Affirm for orders over $150.',
      },
      {
        question: 'Is my payment information secure?',
        answer: 'Absolutely. We use industry-standard SSL encryption and never store your complete credit card information. All transactions are processed through secure, PCI-compliant payment providers.',
      },
      {
        question: 'Do I need an account to place an order?',
        answer: 'No, you can checkout as a guest. However, creating an account lets you track orders, save your wishlist, and checkout faster on future purchases.',
      },
      {
        question: 'How do I reset my password?',
        answer: 'Click "Sign In" then "Forgot Password" and enter your email address. We\'ll send you a link to reset your password. The link expires in 24 hours for security.',
      },
    ],
  },
];

const FAQPage: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Shop
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="text-center mb-12">
              <span className="text-5xl mb-4 block">❓</span>
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-4">
                Frequently Asked Questions
              </h1>
              <p className="font-doodle text-lg text-doodle-text/70">
                Got questions? We've got answers!
              </p>
            </div>

            {/* FAQ Categories */}
            <div className="space-y-8">
              {faqData.map((category, categoryIndex) => (
                <div key={categoryIndex} className="doodle-card p-6 md:p-8">
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4 flex items-center gap-2">
                    <span>{category.icon}</span>
                    {category.title}
                  </h2>
                  
                  <Accordion type="single" collapsible className="w-full">
                    {category.questions.map((faq, faqIndex) => (
                      <AccordionItem 
                        key={faqIndex} 
                        value={`${categoryIndex}-${faqIndex}`}
                        className="border-b-2 border-dashed border-doodle-text/20 last:border-0"
                      >
                        <AccordionTrigger className="font-doodle text-left hover:text-doodle-accent hover:no-underline py-4">
                          {faq.question}
                        </AccordionTrigger>
                        <AccordionContent className="font-doodle text-doodle-text/70 pb-4">
                          {faq.answer}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              ))}
            </div>

            {/* Still Need Help */}
            <div className="doodle-card p-6 md:p-8 mt-8 bg-doodle-accent/5">
              <div className="text-center">
                <HelpCircle className="w-12 h-12 mx-auto mb-4 text-doodle-accent" />
                <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-2">
                  Still Have Questions?
                </h2>
                <p className="font-doodle text-doodle-text/70 mb-6">
                  Our friendly support team is here to help!
                </p>
                <div className="flex flex-col sm:flex-row justify-center gap-4">
                  <a 
                    href="mailto:hello@adventureworks.com" 
                    className="doodle-button doodle-button-primary inline-flex items-center justify-center gap-2"
                  >
                    <Mail className="w-4 h-4" />
                    Email Us
                  </a>
                  <a 
                    href="tel:+15551234567" 
                    className="doodle-button inline-flex items-center justify-center gap-2"
                  >
                    <Phone className="w-4 h-4" />
                    (555) 123-4567
                  </a>
                </div>
                <p className="font-doodle text-sm text-doodle-text/50 mt-4">
                  Available Monday - Friday, 9am - 6pm EST
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default FAQPage;
