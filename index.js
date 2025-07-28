const mongoose = require('mongoose');
const Express = require('express');
// const { json } = require('body-parser');
const swaggerUI = require('swagger-ui-express');
const swaggerSpec = require('./config/swaggerConfig');
const cors = require('cors');
const compression = require('compression');
require('dotenv').config();


// Important
const app = Express();
app.use(Express.json()); 
app.use('/docs', swaggerUI.serve, swaggerUI.setup(swaggerSpec));
app.use(cors());
// Routers
app.use('/user',require('./routes/usersRoute'));
app.use('/channel', require('./routes/channelRoute'));
app.use('/video', require('./routes/videoRoute'));

app.use(compression());


mongoose.connect(process.env.MONGODB_URI)
    .then(()=>console.log('Connected to MongoDB'))
    .catch(err=>console.log('Could Not Connect to MongoDB ..',err));

// Middlewares 
const errorMW = require('./middleware/errorMW')   

// Final Error Handling Middlware
app.use(errorMW);

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Listening port ${PORT} ...`));


app.get('/wake-up', (req, res) => {
  res.status(200).send('Backend is awake!');
});


// const path = require('path');

// app.get('/form', (req, res) => {
//   res.sendFile(path.join(__dirname, 'upload.html')); // Make sure the file is in root or adjust the path
// });