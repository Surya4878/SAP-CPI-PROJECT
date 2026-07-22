require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const proxy = require('./src/proxy');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(morgan('dev'));

// Parse JSON bodies (though mainly used for GET proxying, good to have)
app.use(express.json());

// Main MCP entry point for CPI
app.all('/cpi/*', proxy);

app.listen(PORT, () => {
  console.log(`[CPI-MCP] Server listening on port ${PORT}`);
  console.log(`[CPI-MCP] Read-only proxy initialized.`);
});
