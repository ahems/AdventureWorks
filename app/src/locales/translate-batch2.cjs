const fs = require('fs');
const path = require('path');

// Second batch: category, search, sale, notFound - these are commonly visited pages
const translations = {
  es: {
    category: {
      backToHome: "Volver al Inicio",
      notFound: "Categoría No Encontrada",
      productsAvailable: "{{count}} producto disponible",
      productsAvailable_plural: "{{count}} productos disponibles",
      allProducts: "Todos los {{name}}",
      noProductsFound: "No se encontraron productos"
    },
    search: {
      title: "Resultados de Búsqueda",
      searchFor: "Buscar",
      searchPlaceholder: "Buscar productos...",
      searchButton: "Buscar",
      clearAll: "Borrar todo",
      category: "Categoría",
      allCategories: "Todas las Categorías",
      priceRange: "Rango de Precio",
      sortPriceAsc: "Precio: Menor a Mayor",
      sortPriceDesc: "Precio: Mayor a Menor",
      noResults: "No se encontraron productos",
      noResultsDesc: "Intenta ajustar tus filtros o términos de búsqueda",
      showingResults: "Mostrando {{start}}-{{end}} de {{total}} resultados"
    },
    sale: {
      title: "Artículos en Oferta",
      subtitle: "¡No te pierdas estas increíbles ofertas! Ofertas por tiempo limitado en nuestro mejor equipo.",
      noSaleItems: "No Hay Artículos en Oferta Ahora",
      checkBackSoon: "¡Vuelve pronto para ver ofertas increíbles!"
    },
    notFound: {
      title: "¡Sendero No Encontrado!",
      description: "Parece que te has desviado del camino. ¡No te preocupes, incluso los mejores aventureros se pierden a veces!",
      backToCamp: "Volver al Campamento"
    }
  },
  fr: {
    category: {
      backToHome: "Retour à l'Accueil",
      notFound: "Catégorie Non Trouvée",
      productsAvailable: "{{count}} produit disponible",
      productsAvailable_plural: "{{count}} produits disponibles",
      allProducts: "Tous les {{name}}",
      noProductsFound: "Aucun produit trouvé"
    },
    search: {
      title: "Résultats de Recherche",
      searchFor: "Rechercher",
      searchPlaceholder: "Rechercher des produits...",
      searchButton: "Rechercher",
      clearAll: "Tout effacer",
      category: "Catégorie",
      allCategories: "Toutes les Catégories",
      priceRange: "Fourchette de Prix",
      sortPriceAsc: "Prix: Croissant",
      sortPriceDesc: "Prix: Décroissant",
      noResults: "Aucun produit trouvé",
      noResultsDesc: "Essayez d'ajuster vos filtres ou termes de recherche",
      showingResults: "Affichage de {{start}}-{{end}} sur {{total}} résultats"
    },
    sale: {
      title: "Articles en Solde",
      subtitle: "Ne manquez pas ces offres incroyables! Offres à durée limitée sur notre meilleur équipement.",
      noSaleItems: "Aucun Article en Solde Pour le Moment",
      checkBackSoon: "Revenez bientôt pour des offres incroyables!"
    },
    notFound: {
      title: "Sentier Non Trouvé!",
      description: "On dirait que vous vous êtes égaré du chemin. Ne vous inquiétez pas, même les meilleurs aventuriers se perdent parfois!",
      backToCamp: "Retour au Camp"
    }
  },
  ar: {
    category: {
      backToHome: "العودة إلى الصفحة الرئيسية",
      notFound: "الفئة غير موجودة",
      productsAvailable: "{{count}} منتج متاح",
      productsAvailable_plural: "{{count}} منتج متاح",
      allProducts: "جميع {{name}}",
      noProductsFound: "لم يتم العثور على منتجات"
    },
    search: {
      title: "نتائج البحث",
      searchFor: "البحث عن",
      searchPlaceholder: "البحث عن منتجات...",
      searchButton: "بحث",
      clearAll: "مسح الكل",
      category: "الفئة",
      allCategories: "جميع الفئات",
      priceRange: "نطاق السعر",
      sortPriceAsc: "السعر: من الأقل للأعلى",
      sortPriceDesc: "السعر: من الأعلى للأقل",
      noResults: "لم يتم العثور على منتجات",
      noResultsDesc: "حاول تعديل الفلاتر أو مصطلحات البحث",
      showingResults: "عرض {{start}}-{{end}} من {{total}} نتيجة"
    },
    sale: {
      title: "عناصر التخفيضات",
      subtitle: "لا تفوت هذه العروض المذهلة! عروض لفترة محدودة على أفضل معداتنا.",
      noSaleItems: "لا توجد عناصر معروضة الآن",
      checkBackSoon: "تحقق مرة أخرى قريباً للحصول على عروض مذهلة!"
    },
    notFound: {
      title: "المسار غير موجود!",
      description: "يبدو أنك ابتعدت عن الطريق المألوف. لا تقلق، حتى أفضل المغامرين يضيعون أحياناً!",
      backToCamp: "العودة إلى المعسكر"
    }
  },
  he: {
    category: {
      backToHome: "חזור לדף הבית",
      notFound: "הקטגוריה לא נמצאה",
      productsAvailable: "{{count}} מוצר זמין",
      productsAvailable_plural: "{{count}} מוצרים זמינים",
      allProducts: "כל ה{{name}}",
      noProductsFound: "לא נמצאו מוצרים"
    },
    search: {
      title: "תוצאות חיפוש",
      searchFor: "חפש",
      searchPlaceholder: "חפש מוצרים...",
      searchButton: "חפש",
      clearAll: "נקה הכל",
      category: "קטגוריה",
      allCategories: "כל הקטגוריות",
      priceRange: "טווח מחירים",
      sortPriceAsc: "מחיר: מנמוך לגבוה",
      sortPriceDesc: "מחיר: מגבוה לנמוך",
      noResults: "לא נמצאו מוצרים",
      noResultsDesc: "נסה להתאים את הפילטרים או מונחי החיפוש",
      showingResults: "מציג {{start}}-{{end}} מתוך {{total}} תוצאות"
    },
    sale: {
      title: "פריטים במבצע",
      subtitle: "אל תפספס את העסקאות המדהימות האלה! הצעות לזמן מוגבל על הציוד הטוב ביותר שלנו.",
      noSaleItems: "אין פריטים במבצע כרגע",
      checkBackSoon: "חזור בקרוב לעסקאות מדהימות!"
    },
    notFound: {
      title: "השביל לא נמצא!",
      description: "נראה שסטית מהשביל המוכר. אל תדאג, אפילו ההרפתקנים הטובים ביותר מתעים לפעמים!",
      backToCamp: "חזור למחנה"
    }
  },
  th: {
    category: {
      backToHome: "กลับหน้าแรก",
      notFound: "ไม่พบหมวดหมู่",
      productsAvailable: "มีสินค้า {{count}} ชิ้น",
      productsAvailable_plural: "มีสินค้า {{count}} ชิ้น",
      allProducts: "{{name}} ทั้งหมด",
      noProductsFound: "ไม่พบสินค้า"
    },
    search: {
      title: "ผลการค้นหา",
      searchFor: "ค้นหา",
      searchPlaceholder: "ค้นหาสินค้า...",
      searchButton: "ค้นหา",
      clearAll: "ล้างทั้งหมด",
      category: "หมวดหมู่",
      allCategories: "หมวดหมู่ทั้งหมด",
      priceRange: "ช่วงราคา",
      sortPriceAsc: "ราคา: ต่ำไปสูง",
      sortPriceDesc: "ราคา: สูงไปต่ำ",
      noResults: "ไม่พบสินค้า",
      noResultsDesc: "ลองปรับเปลี่ยนตัวกรองหรือคำค้นหา",
      showingResults: "แสดง {{start}}-{{end}} จาก {{total}} รายการ"
    },
    sale: {
      title: "สินค้าลดราคา",
      subtitle: "อย่าพลาดข้อเสนอที่น่าทึ่งเหล่านี้! ข้อเสนอพิเศษจำกัดเวลาสำหรับอุปกรณ์ที่ดีที่สุดของเรา",
      noSaleItems: "ไม่มีสินค้าลดราคาในขณะนี้",
      checkBackSoon: "กลับมาดูข้อเสนอที่น่าทึ่งเร็วๆ นี้!"
    },
    notFound: {
      title: "ไม่พบเส้นทาง!",
      description: "ดูเหมือนว่าคุณหลงทางไปจากเส้นทางที่คุ้นเคย ไม่ต้องกังวล แม้แต่นักผจญภัยที่เก่งที่สุดก็หลงทางบ้าง!",
      backToCamp: "กลับไปที่ค่าย"
    }
  },
  'zh-cht': {
    category: {
      backToHome: "返回首頁",
      notFound: "未找到類別",
      productsAvailable: "{{count}} 件產品可用",
      productsAvailable_plural: "{{count}} 件產品可用",
      allProducts: "所有{{name}}",
      noProductsFound: "未找到產品"
    },
    search: {
      title: "搜尋結果",
      searchFor: "搜尋",
      searchPlaceholder: "搜尋產品...",
      searchButton: "搜尋",
      clearAll: "清除全部",
      category: "類別",
      allCategories: "所有類別",
      priceRange: "價格範圍",
      sortPriceAsc: "價格：由低至高",
      sortPriceDesc: "價格：由高至低",
      noResults: "未找到產品",
      noResultsDesc: "請嘗試調整您的篩選器或搜尋詞",
      showingResults: "顯示 {{start}}-{{end}} / {{total}} 項結果"
    },
    sale: {
      title: "特價商品",
      subtitle: "不要錯過這些驚人的優惠！我們最佳裝備的限時優惠。",
      noSaleItems: "目前沒有特價商品",
      checkBackSoon: "即將推出驚人優惠，敬請期待！"
    },
    notFound: {
      title: "找不到路徑！",
      description: "看來您偏離了既定的道路。別擔心，即使是最優秀的冒險家有時也會迷路！",
      backToCamp: "返回營地"
    }
  }
};

for (const [lang, sections] of Object.entries(translations)) {
  const filePath = path.join(lang, 'common.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  data.category = { ...data.category, ...sections.category };
  data.search = { ...data.search, ...sections.search };
  data.sale = { ...data.sale, ...sections.sale };
  data.notFound = { ...data.notFound, ...sections.notFound };
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Updated ${lang}/common.json - category, search, sale, notFound`);
}

console.log('\n✅ Second batch complete - category, search, sale, and notFound pages!');
console.log('\n⚠️  STILL REMAINING (hundreds of strings):');
console.log('- orderTracking (20+ strings)');
console.log('- orderConfirmation (10+ strings)');
console.log('- account (50+ strings)');
console.log('- checkout (30+ strings)');
console.log('- compare (15+ strings)');
console.log('- wishlist (10+ strings)');
console.log('- returns (20+ strings)');
console.log('- faq (30+ strings)');
console.log('\nThese are complex feature pages with many strings each.');
console.log('Recommend translating these as users request specific pages.');
