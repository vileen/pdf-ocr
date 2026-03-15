module.exports = {
  apps: [
    {
      name: 'pdf-ocr-tunnel',
      script: '/opt/homebrew/bin/cloudflared',
      args: 'tunnel --config /Users/dominiksoczewka/.cloudflared/pdf-ocr.yml run pdf-ocr',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};