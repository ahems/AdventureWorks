import { useTranslation } from "react-i18next";
import { TwemojiText } from "@/components/TwemojiText";

/**
 * Hook that extends i18next's useTranslation to provide emoji-aware translations.
 * Returns both the standard translation function and a component factory for emoji text.
 *
 * @example
 * const { t, Emoji } = useEmojiTranslation("common");
 * return <Emoji k="header.demoHint" size="1rem" />;
 */
export const useEmojiTranslation = (namespace?: string) => {
  const { t, i18n } = useTranslation(namespace);

  // Component factory for rendering translated text with emojis
  const Emoji = ({
    k,
    size = "1em",
    className = "",
  }: {
    k: string;
    size?: string;
    className?: string;
  }) => <TwemojiText text={t(k)} size={size} className={className} />;

  return { t, i18n, Emoji };
};
