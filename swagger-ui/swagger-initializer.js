window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: 'openapi.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    tryItOutEnabled: true,
    docExpansion: 'list',
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
  });
};
