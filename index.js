const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.post('/api/auth',  require('./api/auth'));
app.get ('/api/data',  require('./api/data'));
app.get ('/api/db',    require('./api/db'));
app.post('/api/score', require('./api/score'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Iron-IQ listening on port ${PORT}`));