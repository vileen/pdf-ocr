const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3010;

// Request logging middleware (must be first!)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// Middleware
app.use(cors({
  origin: ['https://vileen.github.io', 'https://pdf.vileen.pl', 'http://localhost:3002'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
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

// Error handling middleware for multer
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field name. Use "pdf" as field name.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// OpenDataLoader conversion endpoint
app.post('/api/convert', upload.single('pdf'), handleMulterError, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const jobId = Date.now().toString();
  const pdfPath = req.file.path;
  const outputDir = path.join(OUTPUT_DIR, jobId);
  const outputFormat = req.body.format || 'markdown';
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  
  progressMap.set(jobId, { status: 'starting', progress: 0, message: 'Starting OpenDataLoader...' });
  
  // Start conversion process in background
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  processOpenDataLoader(jobId, pdfPath, outputDir, baseUrl, outputFormat);
  
  res.json({ jobId, message: 'OpenDataLoader conversion started' });
});

// OCR endpoint
app.post('/api/ocr', upload.single('pdf'), handleMulterError, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const jobId = Date.now().toString();
  const pdfPath = req.file.path;
  const outputDir = path.join(OUTPUT_DIR, jobId);
  const outputFormat = req.body.format || 'txt';
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  
  progressMap.set(jobId, { status: 'starting', progress: 0, totalPages: 0, currentPage: 0 });
  
  // Start OCR process in background
  processOCR(jobId, pdfPath, outputDir, outputFormat);
  
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
  const outputDir = path.join(OUTPUT_DIR, req.params.jobId);
  const progress = progressMap.get(req.params.jobId);
  
  // Check if PDF output was requested
  if (progress && progress.outputFormat === 'pdf') {
    const pdfFile = path.join(outputDir, 'result.pdf');
    if (fs.existsSync(pdfFile)) {
      return res.download(pdfFile, 'ocr-result.pdf');
    }
  }
  
  // Default to TXT
  const txtFile = path.join(outputDir, 'result.txt');
  if (!fs.existsSync(txtFile)) {
    return res.status(404).json({ error: 'Result not ready' });
  }
  res.download(txtFile, 'ocr-result.txt');
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

// Get extracted image
app.get('/api/images/:jobId/:filename', (req, res) => {
  const imageFile = path.join(OUTPUT_DIR, req.params.jobId, 'images', req.params.filename);
  if (!fs.existsSync(imageFile)) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.sendFile(path.resolve(imageFile));
});

async function processOpenDataLoader(jobId, pdfPath, outputDir, baseUrl, format = 'markdown') {
  try {
    const { spawn } = require('child_process');
    
    progressMap.set(jobId, { status: 'processing', progress: 10, message: 'Converting with OpenDataLoader...' });
    
    // Run OpenDataLoader Python script with Java PATH
    const pythonProcess = spawn('python3', [
      '-c',
      `
import sys
sys.path.insert(0, '/Users/dominiksoczewka/Projects/speech-practice/backend/src')
from services.pdf_converter import convert_pdf
import json

result = convert_pdf(
    "${pdfPath}",
    "${outputDir}",
    format="${format}",
    hybrid=False,
    ocr=False
)
print(json.dumps(result))
      `
    ], {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/opt/openjdk/bin:${process.env.PATH}`
      }
    });
    
    let output = '';
    let errorOutput = '';
    
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('OpenDataLoader stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          if (result.success) {
            // Read the converted content
            let content = fs.readFileSync(result.output, 'utf-8');
            
            // Check for images folder
            const outputMdPath = path.dirname(result.output);
            const imagesFolderName = path.basename(result.output, path.extname(result.output)) + '_images';
            const imagesSourceDir = path.join(outputMdPath, imagesFolderName);
            const imagesTargetDir = path.join(outputDir, 'images');
            
            if (fs.existsSync(imagesSourceDir)) {
              // Copy images folder to output
              fs.mkdirSync(imagesTargetDir, { recursive: true });
              const imageFiles = fs.readdirSync(imagesSourceDir);
              for (const file of imageFiles) {
                fs.copyFileSync(
                  path.join(imagesSourceDir, file),
                  path.join(imagesTargetDir, file)
                );
              }
              
              // Update markdown links to use API endpoint
              content = content.replace(
                new RegExp(`${imagesFolderName}/`, 'g'),
                `${baseUrl}/api/images/${jobId}/`
              );
            }
            
            fs.writeFileSync(path.join(outputDir, 'result.txt'), content);
            
            progressMap.set(jobId, { 
              status: 'completed', 
              progress: 100, 
              message: 'OpenDataLoader conversion completed!',
              totalPages: 1,
              currentPage: 1,
              hasImages: fs.existsSync(imagesSourceDir)
            });
          } else {
            throw new Error(result.error || 'Conversion failed');
          }
        } catch (e) {
          console.error('OpenDataLoader error:', e);
          progressMap.set(jobId, { status: 'error', progress: 0, message: e.message });
        }
      } else {
        progressMap.set(jobId, { status: 'error', progress: 0, message: errorOutput || 'OpenDataLoader process failed' });
      }
      
      // Cleanup PDF after processing
      setTimeout(() => {
        try {
          fs.unlinkSync(pdfPath);
        } catch (e) {
          console.error('Cleanup error:', e);
        }
      }, 60000);
    });
    
  } catch (error) {
    console.error('OpenDataLoader Error:', error);
    logError(`OpenDataLoader Job ${jobId} failed: ${error.message}`);
    progressMap.set(jobId, { status: 'error', progress: 0, message: error.message });
  }
}

async function processOCR(jobId, pdfPath, outputDir, outputFormat = 'txt') {
  try {
    progressMap.set(jobId, { status: 'converting', progress: 5, message: 'Converting PDF to images...' });

    // Convert PDF to images
    const images = await pdfToImages(pdfPath, outputDir);
    const totalPages = images.length;

    if (outputFormat === 'pdf') {
      // Use native Tesseract CLI for PDF output
      progressMap.set(jobId, { status: 'processing', progress: 10, totalPages, currentPage: 0, message: `Creating searchable PDF...` });

      // For PDF output, we need to process each image and combine
      // Tesseract can output PDF directly from images
      const outputPdfPath = path.join(outputDir, 'result.pdf');

      // Process each image and collect PDF outputs
      const pdfPages = [];
      for (let i = 0; i < images.length; i++) {
        const imagePath = images[i];
        const pageNum = i + 1;
        const pagePdfPath = path.join(outputDir, `page_${pageNum}.pdf`);

        progressMap.set(jobId, {
          status: 'processing',
          progress: 10 + Math.round((i / totalPages) * 80),
          totalPages,
          currentPage: pageNum,
          message: `Processing page ${pageNum} of ${totalPages}...`
        });

        // Run Tesseract CLI to create PDF
        await new Promise((resolve, reject) => {
          const tesseractCmd = spawn('tesseract', [imagePath, pagePdfPath.replace('.pdf', ''), 'pdf', '-l', 'eng+jpn']);
          let errorOutput = '';

          tesseractCmd.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });

          tesseractCmd.on('close', (code) => {
            if (code === 0) {
              pdfPages.push(pagePdfPath);
              resolve();
            } else {
              reject(new Error(`Tesseract failed: ${errorOutput}`));
            }
          });
        });
      }

      // Combine PDF pages using PDFtk or similar if needed
      // For now, if single page, just rename, otherwise we need a PDF merger
      if (pdfPages.length === 1) {
        fs.renameSync(pdfPages[0], outputPdfPath);
      } else {
        // Use qpdf or similar to combine PDFs
        try {
          const qpdfCmd = spawn('qpdf', ['--empty', '--pages', ...pdfPages, '--', outputPdfPath]);
          await new Promise((resolve, reject) => {
            let errorOutput = '';
            qpdfCmd.stderr.on('data', (data) => errorOutput += data.toString());
            qpdfCmd.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`PDF merge failed: ${errorOutput}`));
            });
          });
        } catch (mergeError) {
          // Fallback: just use the first page PDF
          console.warn('PDF merge failed, using first page:', mergeError.message);
          fs.renameSync(pdfPages[0], outputPdfPath);
        }
      }

      // Also create TXT for preview
      const tesseract = require('tesseract.js');
      let fullText = '';
      for (let i = 0; i < Math.min(images.length, 3); i++) {
        const result = await tesseract.recognize(images[i], 'eng+jpn');
        fullText += `\n--- Page ${i + 1} ---\n${result.data.text}\n`;
      }
      if (images.length > 3) {
        fullText += `\n... and ${images.length - 3} more pages\n`;
      }
      fs.writeFileSync(path.join(outputDir, 'result.txt'), fullText + '\n\n[PDF output available for download]');

      progressMap.set(jobId, { status: 'completed', progress: 100, message: 'PDF OCR completed!', totalPages, currentPage: totalPages, outputFormat: 'pdf' });
    } else {
      // TXT output using tesseract.js
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

      progressMap.set(jobId, { status: 'completed', progress: 100, message: 'OCR completed!', totalPages, currentPage: totalPages, outputFormat: 'txt' });
    }

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
