const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure directories exist
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Error logging
function logError(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(LOGS_DIR, 'error.log'), logEntry);
}

// Multer configuration for large files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Progress tracking
const progressMap = new Map();

// Convert PDF to images using pdftoppm
async function pdfToImages(pdfPath, outputDir) {
  const baseName = path.basename(pdfPath, '.pdf');
  const outputPrefix = path.join(outputDir, baseName + '-page');
  
  // Use pdftoppm to convert PDF to PNG images
  const cmd = `pdftoppm -png -r 300 "${pdfPath}" "${outputPrefix}"`;
  await execAsync(cmd);
  
  // Get list of generated images
  const files = fs.readdirSync(outputDir);
  const images = files
    .filter(f => f.startsWith(baseName + '-page') && f.endsWith('.png'))
    .sort()
    .map(f => path.join(outputDir, f));
  
  return images;
}

// OCR endpoint
app.post('/api/ocr', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const jobId = Date.now().toString();
  const pdfPath = req.file.path;
  const outputDir = path.join(OUTPUT_DIR, jobId);
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  
  progressMap.set(jobId, { status: 'starting', progress: 0, totalPages: 0, currentPage: 0 });
  
  // Start OCR process in background
  processOCR(jobId, pdfPath, outputDir);
  
  res.json({ jobId, message: 'OCR started' });
});

// Progress endpoint
app.get('/api/progress/:jobId', (req, res) => {
  const progress = progressMap.get(req.params.jobId);
  if (!progress) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(progress);
});

// Download result
app.get('/api/download/:jobId', (req, res) => {
  const outputFile = path.join(OUTPUT_DIR, req.params.jobId, 'result.txt');
  if (!fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'Result not ready' });
  }
  res.download(outputFile, 'ocr-result.txt');
});

// Get result text
app.get('/api/result/:jobId', (req, res) => {
  const outputFile = path.join(OUTPUT_DIR, req.params.jobId, 'result.txt');
  if (!fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'Result not ready' });
  }
  const text = fs.readFileSync(outputFile, 'utf-8');
  res.json({ text });
});

async function processOCR(jobId, pdfPath, outputDir) {
  try {
    progressMap.set(jobId, { status: 'converting', progress: 5, message: 'Converting PDF to images...' });
    
    // Convert PDF to images
    const images = await pdfToImages(pdfPath, outputDir);
    const totalPages = images.length;
    
    progressMap.set(jobId, { status: 'processing', progress: 10, totalPages, currentPage: 0, message: `Processing ${totalPages} pages...` });
    
    const tesseract = require('tesseract.js');
    let fullText = '';
    
    for (let i = 0; i < images.length; i++) {
      const imagePath = images[i];
      const pageNum = i + 1;
      
      progressMap.set(jobId, { 
        status: 'processing', 
        progress: 10 + Math.round((i / totalPages) * 80), 
        totalPages, 
        currentPage: pageNum,
        message: `Processing page ${pageNum} of ${totalPages}...`
      });
      
      const result = await tesseract.recognize(imagePath, 'eng+jpn', {
        logger: m => {
          // Optional: log progress
        }
      });
      
      fullText += `\n--- Page ${pageNum} ---\n`;
      fullText += result.data.text;
      fullText += '\n';
    }
    
    // Save result
    fs.writeFileSync(path.join(outputDir, 'result.txt'), fullText);
    
    progressMap.set(jobId, { status: 'completed', progress: 100, message: 'OCR completed!', totalPages, currentPage: totalPages });
    
    // Cleanup PDF and images after processing
    setTimeout(() => {
      try {
        fs.unlinkSync(pdfPath);
        images.forEach(img => fs.unlinkSync(img));
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }, 60000); // Cleanup after 1 minute
    
  } catch (error) {
    console.error('OCR Error:', error);
    logError(`OCR Job ${jobId} failed: ${error.message}`);
    progressMap.set(jobId, { status: 'error', progress: 0, message: error.message });
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`PDF OCR Server running on port ${PORT}`);
});
