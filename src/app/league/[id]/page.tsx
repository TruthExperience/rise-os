00:33:54.049 Running build in Washington, D.C., USA (East) – iad1
00:33:54.050 Build machine configuration: 2 cores, 8 GB
00:33:54.168 Cloning github.com/TruthExperience/rise-os (Branch: main, Commit: edc83c6)
00:33:54.380 Cloning completed: 212.000ms
00:33:55.482 Restored build cache from previous deployment (BMYAuTvUTKYWJ9H6LhcL8jScK6y9)
00:33:55.674 Running "vercel build"
00:33:55.691 Vercel CLI 54.14.0
00:33:55.971 Installing dependencies...
00:33:59.756 
00:33:59.757 up to date in 4s
00:33:59.757 
00:33:59.758 171 packages are looking for funding
00:33:59.758   run `npm fund` for details
00:33:59.786 Detected Next.js version: 14.2.3
00:33:59.794 Running "npm run build"
00:33:59.888 
00:33:59.888 > rise-os@0.1.0 build
00:33:59.889 > next build
00:33:59.889 
00:34:01.121   ▲ Next.js 14.2.3
00:34:01.121 
00:34:01.137    Creating an optimized production build ...
00:34:01.628  ✓ (pwa) Compiling for server...
00:34:01.631  ✓ (pwa) Compiling for server...
00:34:01.633  ✓ (pwa) Compiling for client (static)...
00:34:01.635  ○ (pwa) Service worker: /vercel/path0/public/sw.js
00:34:01.636  ○ (pwa)   URL: /sw.js
00:34:01.636  ○ (pwa)   Scope: /
00:34:07.426  ✓ Compiled successfully
00:34:07.431    Linting and checking validity of types ...
00:34:10.695    Collecting page data ...
00:34:11.787    Generating static pages (0/8) ...
00:34:12.076    Generating static pages (2/8) 
00:34:12.345    Generating static pages (4/8) 
00:34:12.430    Generating static pages (6/8) 
00:34:12.483  ✓ Generating static pages (8/8)
00:34:12.687    Finalizing page optimization ...
00:34:12.688    Collecting build traces ...
00:34:17.235 
00:34:17.238 Route (app)                              Size     First Load JS
00:34:17.238 ┌ ○ /                                    138 B          89.5 kB
00:34:17.239 ├ ○ /_not-found                          872 B          90.2 kB
00:34:17.239 ├ ƒ /api/auth/[...nextauth]              0 B                0 B
00:34:17.239 ├ ƒ /api/leagues                         0 B                0 B
00:34:17.239 ├ ƒ /api/leagues/[id]                    0 B                0 B
00:34:17.239 ├ ○ /dashboard                           1.23 kB         100 kB
00:34:17.240 ├ ○ /league                              63 kB           162 kB
00:34:17.240 ├ ƒ /league/[id]                         1.37 kB         100 kB
00:34:17.240 └ ○ /login                               1.26 kB         100 kB
00:34:17.243 + First Load JS shared by all            89.3 kB
00:34:17.243   ├ chunks/190-93b42105784e459c.js       33.7 kB
00:34:17.243   ├ chunks/fd9d1056-4e1a26e2d413ba3c.js  53.6 kB
00:34:17.243   └ other shared chunks (total)          1.96 kB
00:34:17.244 
00:34:17.244 
00:34:17.244 ○  (Static)   prerendered as static content
00:34:17.244 ƒ  (Dynamic)  server-rendered on demand
00:34:17.244 
00:34:17.361 Traced Next.js server files in: 33.218ms
00:34:17.504 Created all serverless functions in: 142.636ms
00:34:17.518 Collected static files (public/, static/, .next/static): 4.932ms
00:34:17.585 Build Completed in /vercel/output [22s]
00:34:17.721 Deploying outputs...
00:34:22.845 Deployment completed
00:34:22.958 Creating build cache...