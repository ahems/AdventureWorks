import React, { useEffect, useRef } from "react";
import twemoji from "twemoji";

interface TwemojiProps {
  emoji: string;
  className?: string;
  size?: string;
}

export const Twemoji: React.FC<TwemojiProps> = ({
  emoji,
  className = "",
  size = "1.5em",
}) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = twemoji.parse(emoji, {
        folder: "svg",
        ext: ".svg",
      });

      // Set size on the img element
      const img = ref.current.querySelector("img");
      if (img) {
        img.style.width = size;
        img.style.height = size;
        img.style.display = "inline-block";
        img.style.verticalAlign = "middle";
      }
    }
  }, [emoji, size]);

  return <span ref={ref} className={className} />;
};
