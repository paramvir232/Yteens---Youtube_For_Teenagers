const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'YTeens API Docs',
      version: '1.0.0',
      description: 'Backend API for YouTube Teens Platform'
    },
    servers: [
      {
        url: 'https://api-yteens.onrender.com',
        description: 'Production server'
      }
    ]
  },
  apis: ['./routes/*.js', './swagger/*.yaml'] // Paths to your route files or separate yaml
};

const swaggerSpec = swaggerJSDoc(options);
module.exports = swaggerSpec;
