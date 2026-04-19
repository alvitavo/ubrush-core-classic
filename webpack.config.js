const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const BRUSHES_DIR = path.resolve(__dirname, 'brushes');
const BRUSHES_ORIGINAL_DIR = path.resolve(__dirname, 'brushes_original');

module.exports = {
  entry: './src/ubrushCore/main.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            compilerOptions: { module: 'commonjs' }
          }
        },
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js']
  },
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/ubrushCore/index.html',
      filename: 'index.html'
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'brushes.json', to: 'brushes.json' },
        { from: 'brushCategories.json', to: 'brushCategories.json' },
        { from: 'brushes', to: 'brushes' },
        { from: 'brushSchema.json', to: 'brushSchema.json' }
      ]
    })
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist')
    },
    compress: true,
    port: 3000,
    setupMiddlewares: (middlewares, devServer) => {
      const app = devServer.app;

      // Parse JSON bodies (up to 200 MB for brush data with embedded images)
      app.use('/api', (req, res, next) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try { req.body = body ? JSON.parse(body) : {}; } catch (e) { req.body = {}; }
          next();
        });
      });

      // POST /api/save-brush
      // Body: { categoryFile: 'brushes/airbrush.json', brush: IBrush }
      app.post('/api/save-brush', (req, res) => {
        try {
          const { categoryFile, brush } = req.body;
          if (!categoryFile || !brush || !brush.name) {
            return res.status(400).json({ error: 'categoryFile and brush.name required' });
          }

          // Validate path stays inside brushes/
          const filename = path.basename(categoryFile);
          const filePath = path.join(BRUSHES_DIR, filename);

          const raw = fs.readFileSync(filePath, 'utf8');
          const brushes = JSON.parse(raw);
          const idx = brushes.findIndex(b => b.name === brush.name);
          if (idx === -1) {
            return res.status(404).json({ error: `Brush "${brush.name}" not found in ${filename}` });
          }
          brushes[idx] = brush;
          fs.writeFileSync(filePath, JSON.stringify(brushes, null, 2), 'utf8');
          console.log(`[save-brush] Updated "${brush.name}" in ${filename}`);
          res.json({ ok: true });
        } catch (e) {
          console.error('[save-brush]', e);
          res.status(500).json({ error: String(e) });
        }
      });

      // POST /api/restore-brush
      // Body: { categoryFile: 'brushes/airbrush.json', brushName: string }
      app.post('/api/restore-brush', (req, res) => {
        try {
          const { categoryFile, brushName } = req.body;
          if (!categoryFile || !brushName) {
            return res.status(400).json({ error: 'categoryFile and brushName required' });
          }

          const filename = path.basename(categoryFile);
          const originalPath = path.join(BRUSHES_ORIGINAL_DIR, filename);
          const workingPath = path.join(BRUSHES_DIR, filename);

          const origRaw = fs.readFileSync(originalPath, 'utf8');
          const origBrushes = JSON.parse(origRaw);
          const origBrush = origBrushes.find(b => b.name === brushName);
          if (!origBrush) {
            return res.status(404).json({ error: `Brush "${brushName}" not found in original ${filename}` });
          }

          // Also update the working file
          const workRaw = fs.readFileSync(workingPath, 'utf8');
          const workBrushes = JSON.parse(workRaw);
          const idx = workBrushes.findIndex(b => b.name === brushName);
          if (idx !== -1) {
            workBrushes[idx] = origBrush;
            fs.writeFileSync(workingPath, JSON.stringify(workBrushes, null, 2), 'utf8');
          }

          console.log(`[restore-brush] Restored "${brushName}" in ${filename}`);
          res.json({ ok: true, brush: origBrush });
        } catch (e) {
          console.error('[restore-brush]', e);
          res.status(500).json({ error: String(e) });
        }
      });

      return middlewares;
    }
  }
};
