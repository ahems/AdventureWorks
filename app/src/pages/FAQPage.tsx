import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, HelpCircle, Mail, Phone } from "lucide-react";
import { Twemoji } from "@/components/Twemoji";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface FAQCategory {
  title: string;
  icon: string;
  questions: { question: string; answer: string }[];
}

const FAQPage: React.FC = () => {
  const { t } = useTranslation("common");

  const faqData: FAQCategory[] = [
    {
      title: t("faq.ordersAndShipping"),
      icon: "📦",
      questions: [
        {
          question: t("faq.howLongDoesShippingTake"),
          answer: t("faq.howLongDoesShippingTakeAnswer"),
        },
        {
          question: t("faq.doYouOfferFreeShipping"),
          answer: t("faq.doYouOfferFreeShippingAnswer"),
        },
        {
          question: t("faq.canIChangeOrCancelMyOrder"),
          answer: t("faq.canIChangeOrCancelMyOrderAnswer"),
        },
        {
          question: t("faq.howDoITrackMyOrder"),
          answer: t("faq.howDoITrackMyOrderAnswer"),
        },
      ],
    },
    {
      title: t("faq.returnsAndExchanges"),
      icon: "🔄",
      questions: [
        {
          question: t("faq.whatIsYourReturnPolicy"),
          answer: t("faq.whatIsYourReturnPolicyAnswer"),
        },
        {
          question: t("faq.howDoIStartAReturn"),
          answer: t("faq.howDoIStartAReturnAnswer"),
        },
        {
          question: t("faq.whenWillIReceiveMyRefund"),
          answer: t("faq.whenWillIReceiveMyRefundAnswer"),
        },
        {
          question: t("faq.canIExchangeAnItemForDifferentSize"),
          answer: t("faq.canIExchangeAnItemForDifferentSizeAnswer"),
        },
      ],
    },
    {
      title: t("faq.productsAndSizing"),
      icon: "🚴",
      questions: [
        {
          question: t("faq.howDoIChooseRightBikeSize"),
          answer: t("faq.howDoIChooseRightBikeSizeAnswer"),
        },
        {
          question: t("faq.areYourBikesFullyAssembled"),
          answer: t("faq.areYourBikesFullyAssembledAnswer"),
        },
        {
          question: t("faq.doYouOfferAWarranty"),
          answer: t("faq.doYouOfferAWarrantyAnswer"),
        },
        {
          question: t("faq.whatIfAnItemIsOutOfStock"),
          answer: t("faq.whatIfAnItemIsOutOfStockAnswer"),
        },
      ],
    },
    {
      title: t("faq.accountAndPayment"),
      icon: "💳",
      questions: [
        {
          question: t("faq.whatPaymentMethodsDoYouAccept"),
          answer: t("faq.whatPaymentMethodsDoYouAcceptAnswer"),
        },
        {
          question: t("faq.isMyPaymentInformationSecure"),
          answer: t("faq.isMyPaymentInformationSecureAnswer"),
        },
        {
          question: t("faq.doINeedAnAccountToPlaceOrder"),
          answer: t("faq.doINeedAnAccountToPlaceOrderAnswer"),
        },
        {
          question: t("faq.howDoIResetMyPassword"),
          answer: t("faq.howDoIResetMyPasswordAnswer"),
        },
      ],
    },
  ];

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
            {t("faq.backToShop")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="text-center mb-12">
              <span className="text-5xl mb-4 block">❓</span>
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-4">
                {t("faq.frequentlyAskedQuestions")}
              </h1>
              <p className="font-doodle text-lg text-doodle-text/70">
                {t("faq.gotQuestionsWeGotAnswers")}
              </p>
            </div>

            {/* FAQ Categories */}
            <div className="space-y-8">
              {faqData.map((category, categoryIndex) => (
                <div key={categoryIndex} className="doodle-card p-6 md:p-8">
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4 flex items-center gap-2">
                    <Twemoji emoji={category.icon} size="1.5rem" />
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
                  {t("faq.stillHaveQuestions")}
                </h2>
                <p className="font-doodle text-doodle-text/70 mb-6">
                  {t("faq.ourFriendlySupportTeam")}
                </p>
                <div className="flex flex-col sm:flex-row justify-center gap-4">
                  <a
                    href="mailto:hello@adventureworks.com"
                    className="doodle-button doodle-button-primary inline-flex items-center justify-center gap-2"
                  >
                    <Mail className="w-4 h-4" />
                    {t("faq.emailUs")}
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
                  {t("faq.availableHours")}
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
