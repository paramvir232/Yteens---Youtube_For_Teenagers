const mongoose = require('mongoose');
const Express = require('express');
// const { json } = require('body-parser');

// Important
const app = Express();
app.use(Express.json()); 

// Routers
app.use('/user',require('./routes/usersRoute'));
app.use('/channels', require('./routes/channelRoute'));
app.use('/videos', require('./routes/videoRoute'));



require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI)
    .then(()=>console.log('Connected to MongoDB'))
    .catch(err=>console.log('Could Not Connect to MongoDB ..',err));

// Middlewares 
const errorMW = require('./middleware/errorMW')   

// Final Error Handling Middlware
app.use(errorMW);

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Listening port ${PORT} ...`));