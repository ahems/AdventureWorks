import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  RotateCcw,
  Clock,
  Package,
  CheckCircle,
  AlertCircle,
  Mail,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { TwemojiText } from "@/components/TwemojiText";

const ReturnsPage: React.FC = () => {
  const { t } = useTranslation("common");

  const returnSteps = [
    {
      icon: <Mail className="w-6 h-6" />,
      title: t("returns.contactUs"),
      description: t("returns.contactUsDescription"),
    },
    {
      icon: <Package className="w-6 h-6" />,
      title: t("returns.packItUp"),
      description: t("returns.packItUpDescription"),
    },
    {
      icon: <RotateCcw className="w-6 h-6" />,
      title: t("returns.shipItBack"),
      description: t("returns.shipItBackDescription"),
    },
    {
      icon: <CheckCircle className="w-6 h-6" />,
      title: t("returns.getRefunded"),
      description: t("returns.getRefundedDescription"),
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
            {t("returns.backToShop")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="text-center mb-12">
              <span className="text-5xl mb-4 block">🔄</span>
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-4">
                {t("returns.returnsAndExchanges")}
              </h1>
              <p className="font-doodle text-lg text-doodle-text/70">
                {t("returns.notSatisfiedNoProblem")}
              </p>
            </div>

            {/* Key Info Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
              <div className="doodle-card p-6 text-center">
                <Clock className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">
                  {t("returns.thirtyDayReturns")}
                </h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  {t("returns.returnWithin30Days")}
                </p>
              </div>
              <div className="doodle-card p-6 text-center">
                <Package className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">
                  {t("returns.freeReturns")}
                </h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  {t("returns.prepaidLabelsUS")}
                </p>
              </div>
              <div className="doodle-card p-6 text-center">
                <RotateCcw className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">
                  {t("returns.easyExchanges")}
                </h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  {t("returns.swapForDifferentSizeOrColor")}
                </p>
              </div>
            </div>

            {/* How to Return */}
            <div className="doodle-card p-6 md:p-8 mb-8">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-6">
                {t("returns.howToReturnAnItem")}
              </h2>
              <div className="space-y-6">
                {returnSteps.map((step, index) => (
                  <div key={index} className="flex gap-4">
                    <div className="flex-shrink-0 w-12 h-12 bg-doodle-accent/10 border-2 border-dashed border-doodle-accent rounded-full flex items-center justify-center text-doodle-accent">
                      {step.icon}
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="font-doodle font-bold text-doodle-text">
                        {t("returns.step")} {index + 1}: {step.title}
                      </h3>
                      <p className="font-doodle text-doodle-text/70 mt-1">
                        {step.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Policy Details */}
            <div className="doodle-card p-6 md:p-8 mb-8">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-6">
                {t("returns.returnPolicyDetails")}
              </h2>

              <div className="space-y-6">
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    <TwemojiText
                      text={t("returns.eligibleForReturn")}
                      size="1rem"
                    />
                  </h3>
                  <ul className="font-doodle text-doodle-text/70 space-y-1 ml-4">
                    <li>{t("returns.unusedItemsInOriginalPackaging")}</li>
                    <li>{t("returns.itemsWithAllTagsAttached")}</li>
                    <li>{t("returns.itemsReturnedWithin30Days")}</li>
                    <li>{t("returns.defectiveOrDamagedItems")}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    <TwemojiText
                      text={t("returns.notEligibleForReturn")}
                      size="1rem"
                    />
                  </h3>
                  <ul className="font-doodle text-doodle-text/70 space-y-1 ml-4">
                    <li>{t("returns.usedOrWornItems")}</li>
                    <li>{t("returns.itemsWithoutOriginalPackaging")}</li>
                    <li>{t("returns.customOrPersonalizedItems")}</li>
                    <li>{t("returns.itemsMarkedAsFinalSale")}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    {t("returns.bikeReturns")}
                  </h3>
                  <p className="font-doodle text-doodle-text/70">
                    {t("returns.bikeReturnsDescription")}
                  </p>
                </div>
              </div>
            </div>

            {/* Exchange Info */}
            <div className="doodle-card p-6 md:p-8 mb-8 bg-doodle-accent/5">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-4">
                {t("returns.preferAnExchange")}
              </h2>
              <p className="font-doodle text-doodle-text/70 mb-4">
                {t("returns.exchangeDescription")}
              </p>
              <p className="font-doodle text-sm text-doodle-text/50">
                {t("returns.exchangeNote")}
              </p>
            </div>

            {/* Contact */}
            <div className="doodle-card p-6 md:p-8">
              <div className="flex items-start gap-4">
                <AlertCircle className="w-8 h-8 text-doodle-accent flex-shrink-0 mt-1" />
                <div>
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-2">
                    {t("returns.questionsAboutYourReturn")}
                  </h2>
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    {t("returns.supportDescription")}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <a
                      href="mailto:returns@adventureworks.com"
                      className="doodle-button doodle-button-primary inline-flex items-center gap-2"
                    >
                      <Mail className="w-4 h-4" />
                      {t("returns.emailSupport")}
                    </a>
                    <Link
                      to="/order-tracking"
                      className="doodle-button inline-flex items-center gap-2"
                    >
                      <Package className="w-4 h-4" />
                      {t("returns.trackYourOrder")}
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ReturnsPage;
