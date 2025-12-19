const fs = require('fs');
const path = require('path');

// Function to recursively find all t() calls in TSX files
function findTCalls(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.includes('node_modules')) {
      findTCalls(fullPath, files);
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const hasTranslation = content.includes('useTranslation') || content.includes('withTranslation');
      if (hasTranslation) {
        files.push({ path: fullPath.replace(process.cwd() + '/', ''), content });
      }
    }
  }
  return files;
}

// Load all translation files
const translations = {};
for (const lang of ['en']) { // Only check English for speed
  translations[lang] = {};
  const localeDir = `src/locales/${lang}`;
  for (const file of fs.readdirSync(localeDir)) {
    const namespace = file.replace('.json', '');
    translations[lang][namespace] = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
  }
}

// Check for missing keys
const files = findTCalls('src');
const missing = new Set();
const found = new Set();

files.forEach(file => {
  const content = file.content;
  
  // Find namespace
  const nsMatch = content.match(/useTranslation\(['"]([^'"]+)['"]\)/);
  const namespace = nsMatch ? nsMatch[1] : 'common';
  
  // Find all t() calls
  const tCalls = [...content.matchAll(/\bt\(['"]([^'"]+)['"]/g)];
  
  tCalls.forEach(match => {
    const key = match[1];
    
    // Check if key exists in EN translations
    const parts = key.split('.');
    let value = translations.en[namespace];
    
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        break;
      }
    }
    
    if (!value) {
      missing.add(`${file.path} → ${namespace}.${key}`);
    } else {
      found.add(`${namespace}.${key}`);
    }
  });
});

console.log('Translation Key Audit');
console.log('====================\n');

if (missing.size > 0) {
  console.log('❌ Missing translation keys found:');
  console.log('-----------------------------------');
  [...missing].sort().forEach(m => console.log('  ', m));
  console.log('');
} else {
  console.log('✅ All translation keys exist!');
}

console.log(`\nSummary:`);
console.log(`  Found: ${found.size} working translation keys`);
console.log(`  Missing: ${missing.size} translation keys`);
