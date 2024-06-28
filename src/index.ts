import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import mongoose from "mongoose";
import { authRouter } from './routes/auth';
import { emailRouter } from './routes/email';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI as string;
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("Connected to MongoDB");
    })
    .catch((err) => {
        console.log("Error connecting to MongoDB", err);
    });

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req: Request, res: Response) => {
    res.send('Hello World!');
});

app.use(bodyParser.json());
app.use('/auth', authRouter);
app.use('/email', emailRouter);


app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
