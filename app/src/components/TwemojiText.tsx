import React, { useEffect, useRef } from "react";
import twemoji from "twemoji";

interface TwemojiTextProps {
  text: string;
  className?: string;
  size?: string;
}

/**
 * Component that parses text and converts any emojis to Twemoji SVGs.
 * Use this for translated text that may contain emojis.
 *
 * @example
 * const text = t("account.demoHint"); // "🎭 This is a demo..."
 * <TwemojiText text={text} size="1rem" />
 */
export const TwemojiText: React.FC<TwemojiTextProps> = ({
  text,
  className = "",
  size = "1em",
}) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = twemoji.parse(text, {
        folder: "svg",
        ext: ".svg",
      });

      // Set size on all img elements (emojis)
      const imgs = ref.current.querySelectorAll("img");
      imgs.forEach((img) => {
        img.style.width = size;
        img.style.height = size;
        img.style.display = "inline-block";
        img.style.verticalAlign = "middle";
        img.style.marginRight = "0.25em"; // Small spacing after emoji
      });
    }
  }, [text, size]);

  return <span ref={ref} className={className} />;
};
