# PDF OCR Tool

Web application for extracting text from PDF files using OCR (Optical Character Recognition).

## Features

- 📄 **PDF to Text** - Convert any PDF to editable text
- 🌍 **Multi-language** - Supports English and Japanese
- 📚 **Multi-page** - Process entire PDFs with page-by-page results
- 📦 **Large files** - Handles PDFs up to 100MB
- 🔒 **Privacy** - Files are processed locally and deleted after completion

## Installation

```bash
# Install dependencies
npm install

# Make sure you have pdftoppm installed (for PDF to image conversion)
# macOS:
brew install poppler

# Ubuntu/Debian:
sudo apt-get install poppler-utils

# Start server
npm start
```

Server runs on http://localhost:3002

## Usage

1. Open http://localhost:3002 in browser
2. Drop PDF file or click to browse
3. Wait for OCR processing
4. Download or copy the extracted text

## How it works

1. PDF is uploaded to server
2. Each page is converted to high-resolution PNG image
3. Tesseract.js performs OCR on each page
4. Results are combined into single text file
5. Download the extracted text

## Requirements

- Node.js 16+
- poppler-utils (pdftoppm command)
- ~500MB RAM per 10 pages

## License

MIT