# Using Emojis in Translation Files

This guide explains how to use emojis in translation files and display them as Twemoji SVGs in your React components.

## Overview

The app uses the `TwemojiText` component to automatically convert any emojis in translated strings to high-quality Twemoji SVGs. This ensures consistent emoji rendering across all platforms and browsers.

## How It Works

1. **In Translation Files**: Use emojis directly in your JSON translation files
2. **In Components**: Wrap translated text with the `TwemojiText` component to render emojis as SVGs

## Translation File Examples

### Direct Emoji Characters (Recommended)

```json
{
  "auth": {
    "demoHint": "🎭 This is a demo. Your data is stored in a demo database."
  },
  "footer": {
    "builtWith": "Built with ❤️ using Azure and React"
  },
  "notifications": {
    "success": "✅ Operation completed successfully!",
    "warning": "⚠️ Please review the following items",
    "error": "❌ Something went wrong"
  }
}
```

### Unicode Escape Sequences (Alternative)

You can also use Unicode escape sequences, which are automatically converted:

```json
{
  "auth": {
    "demoHint": "\uD83C\uDFAD This is a demo. Your data is stored in a demo database."
  }
}
```

Both formats work identically with the `TwemojiText` component.

## Component Usage

### Basic Usage

```tsx
import { TwemojiText } from "@/components/TwemojiText";
import { useTranslation } from "react-i18next";

function MyComponent() {
  const { t } = useTranslation("account");

  return (
    <p className="text-sm">
      <TwemojiText text={t("auth.demoHint")} size="0.875rem" />
    </p>
  );
}
```

### With Custom Styling

```tsx
<div className="text-center">
  <TwemojiText
    text={t("notifications.success")}
    size="1rem"
    className="font-bold text-green-600"
  />
</div>
```

### Sizing Guide

Match the emoji size to your text size:

- `size="0.75rem"` - For very small text (text-xs)
- `size="0.875rem"` - For small text (text-sm)
- `size="1rem"` - For normal text (text-base)
- `size="1.25rem"` - For larger text (text-lg)
- `size="1.5rem"` - For headings (text-xl)

## Current Implementations

### AuthPage.tsx

The demo hint at the bottom of the auth form:

```tsx
<p className="font-doodle text-xs text-center text-doodle-text/50">
  <TwemojiText text={t("auth.demoHint")} size="0.875rem" />
</p>
```

Translation: `"🎭 This is a demo. Your data is stored in a demo database."`

### Footer.tsx

The "Built with ❤️" text in the footer:

```tsx
<p className="font-doodle text-sm opacity-60">
  <TwemojiText text={t("builtWith")} size="0.875rem" />
</p>
```

Translation: `"Built with ❤️ using Azure and React"`

## Best Practices

1. **Use emojis sparingly** - They should enhance, not overwhelm the UI
2. **Match emoji size to text** - Use the size prop to ensure visual consistency
3. **Consider accessibility** - Emojis should add context, not be the only indicator
4. **Test across languages** - Ensure emojis make sense in all language contexts

## When NOT to Use TwemojiText

- For standalone emoji icons (use the `Twemoji` component instead)
- For text without any emojis (use plain `{t("key")}`)
- For dynamic emoji content separate from translations

### Example: Standalone Emojis

For individual emoji icons not from translation strings:

```tsx
import { Twemoji } from "@/components/Twemoji";

<Twemoji emoji="🏷️" size="1rem" />
<Twemoji emoji={lang.flag} size="1.25rem" />
```

## Adding New Emoji Translations

1. **Add to translation file**:

   ```json
   {
     "newKey": "🎉 Congratulations! You've earned a reward!"
   }
   ```

2. **Use in component**:

   ```tsx
   <TwemojiText text={t("newKey")} size="1rem" />
   ```

3. **That's it!** The emoji will automatically render as a Twemoji SVG.

## Technical Details

The `TwemojiText` component:

- Uses the `twemoji.parse()` function to convert emojis to SVG
- Loads SVGs from Twitter's CDN (MaxCDN)
- Automatically handles both Unicode characters and escape sequences
- Maintains consistent styling across all platforms
- Adds proper spacing after emojis (0.25em margin-right)

## Migration Guide

If you have existing plain translations with emojis:

**Before:**

```tsx
{
  t("auth.demoHint");
}
```

**After:**

```tsx
<TwemojiText text={t("auth.demoHint")} size="0.875rem" />
```

Remember to import the component:

```tsx
import { TwemojiText } from "@/components/TwemojiText";
```
