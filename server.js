const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Terlalu banyak request, coba lagi dalam 15 menit'
  }
});

app.use('/api/', limiter);

// Cache untuk menyimpan browser instance
let browser = null;

// Fungsi untuk inisialisasi browser
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
  }
  return browser;
}

// Fungsi untuk scraping Pinterest dengan multi aspect ratio
async function scrapePinterest(query, limit = 100) {
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();
  
  try {
    // Set user agent untuk menghindari deteksi bot
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1366, height: 768 });
    
    // Navigasi ke Pinterest search
    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Tunggu gambar dimuat
    await page.waitForSelector('[data-test-id="pin"]', { timeout: 10000 });
    
    // Scroll untuk memuat lebih banyak gambar
    await autoScroll(page);
    
    // Ekstrak URL gambar dengan berbagai aspect ratio
    const imageUrls = await page.evaluate((limit) => {
      const pins = document.querySelectorAll('[data-test-id="pin"] img');
      const urls = [];
      
      // Fungsi untuk mendapatkan aspect ratio kategori
      const getAspectRatioCategory = (width, height) => {
        const ratio = width / height;
        
        if (Math.abs(ratio - 1) < 0.1) return 'Square (1:1)';
        if (Math.abs(ratio - (4/3)) < 0.1) return 'Standard (4:3)';
        if (Math.abs(ratio - (3/2)) < 0.1) return 'Classic (3:2)';
        if (Math.abs(ratio - (16/9)) < 0.1) return 'Widescreen (16:9)';
        if (Math.abs(ratio - (21/9)) < 0.1) return 'Ultra-wide (21:9)';
        if (ratio > 1.5) return 'Landscape';
        if (ratio < 0.8) return 'Portrait';
        return 'Custom';
      };
      
      for (let i = 0; i < Math.min(pins.length, limit); i++) {
        const img = pins[i];
        let src = img.src || img.getAttribute('data-src') || img.getAttribute('srcset');
        
        if (src) {
          // Ambil URL gambar dengan kualitas tinggi
          if (src.includes('236x')) {
            src = src.replace('236x', '736x');
          }
          if (src.includes('474x')) {
            src = src.replace('474x', '736x');
          }
          
          // Dapatkan dimensi gambar
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          const aspectRatio = width && height ? (width / height) : 0;
          
          urls.push({
            url: src,
            alt: img.alt || '',
            title: img.title || '',
            dimensions: {
              width: width,
              height: height,
              aspectRatio: aspectRatio ? aspectRatio.toFixed(2) : 'unknown',
              category: width && height ? getAspectRatioCategory(width, height) : 'unknown'
            }
          });
        }
      }
      
      return urls;
    }, limit);
    
    await page.close();
    return imageUrls;
    
  } catch (error) {
    await page.close();
    throw error;
  }
}

// Fungsi auto scroll
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight || totalHeight >= 3000) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Pinterest API Server - Multi Aspect Ratio',
    version: '1.0.2',
    features: [
      'Support untuk semua aspect ratio (Square, Portrait, Landscape, dll)',
      'Rate limiting untuk stabilitas',
      'High quality image URLs',
      'Informasi detail dimensi gambar',
      'Graceful error handling'
    ],
    endpoints: {
      search: '/api/search?q={query}&limit={number}',
      health: '/api/health'
    },
    example: '/api/search?q=nature&limit=50',
    note: 'Mendukung gambar dengan berbagai aspect ratio: Square, Portrait, Landscape, Widescreen, dll.'
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    browserStatus: browser ? 'Active' : 'Inactive'
  });
});

// Main search endpoint
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { q: query, limit = 50 } = req.query;
    
    // Validasi input
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Parameter "q" (query) diperlukan',
        example: '/api/search?q=nature&limit=50'
      });
    }
    
    if (limit > 100) {
      return res.status(400).json({
        success: false,
        error: 'Maksimal limit adalah 100 gambar per request'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Searching for: "${query}" with limit: ${limit} (multi aspect ratio)`);
    
    // Scraping Pinterest dengan berbagai aspect ratio
    const images = await scrapePinterest(query, parseInt(limit));
    
    // Analisis aspect ratio yang ditemukan
    const aspectRatioStats = images.reduce((stats, img) => {
      const category = img.dimensions.category;
      stats[category] = (stats[category] || 0) + 1;
      return stats;
    }, {});
    
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      query: query,
      count: images.length,
      limit: parseInt(limit),
      aspectRatioSupport: 'Multi aspect ratio (Square, Portrait, Landscape, Widescreen, dll)',
      aspectRatioStats: aspectRatioStats,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      info: 'Mendukung gambar dengan berbagai aspect ratio',
      data: images
    });
    
    console.log(`[${new Date().toISOString()}] Found ${images.length} images (multi aspect ratio) for "${query}" in ${responseTime}ms`);
    console.log(`Aspect ratio distribution:`, aspectRatioStats);
    
  } catch (error) {
    console.error('Error:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Gagal mengambil data dari Pinterest',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint tidak ditemukan',
    availableEndpoints: [
      'GET /',
      'GET /api/health',
      'GET /api/search?q={query}&limit={number}'
    ]
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  
  if (browser) {
    await browser.close();
    console.log('Browser closed');
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  if (browser) {
    await browser.close();
    console.log('Browser closed');
  }
  
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Pinterest API Server running on port ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📖 API Documentation: http://localhost:${PORT}`);
  console.log(`🔍 Example: http://localhost:${PORT}/api/search?q=nature&limit=50`);
  console.log(`📐 Feature: Multi aspect ratio support (Square, Portrait, Landscape, Widescreen)`);
});