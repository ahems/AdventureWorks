// Runtime configuration
// This file is replaced by Docker entrypoint in production with actual environment values
// For local development, it uses the VITE_API_URL from .env as fallback

window.APP_CONFIG = {
  API_URL: 'http://localhost:5000/graphql'
};
