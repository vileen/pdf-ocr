const express = require('express');
const app = express();

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/test', (req, res) => {
  res.json({ message: 'POST works' });
});

app.listen(3003, () => {
  console.log('Test server on port 3003');
});
