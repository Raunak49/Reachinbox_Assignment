import mongoose from "mongoose";

const User = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
    },
    type: {
        type: String,
        required: true,
    },
    googleId: {
        type: String,
        required: false,
    },
    historyId: {
        type: String,
        required: false,
    },
    outlookId: {
        type: String,
        required: false,
    },
    outlookUserId: {
        type: String,
        required: false,
    },
});

const UserModel = mongoose.model("User", User);

export {UserModel};