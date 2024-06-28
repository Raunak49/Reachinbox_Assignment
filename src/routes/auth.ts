import express, { Request, Response } from "express";
import { Router } from "express";
import { UserModel } from "../models/User";
import dotenv from "dotenv";
dotenv.config();
import { google } from "googleapis";
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';

export const authRouter: Router = Router();

const OAuth2 = google.auth.OAuth2;

const auth = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_SECRET,
  process.env.REDIRECT_URI
);

let service_key = process.env.SERVICE_ACCOUNT_KEY as string;
service_key = service_key.replace(/\\n/g, "\n");

const serviceAccountAuth = new google.auth.JWT(
  process.env.SERVICE_ACCOUNT_ID as string,
  undefined,
  service_key,
  ["https://www.googleapis.com/auth/pubsub"]
);

const scopes = [
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
];

authRouter.get("/google", async (req: Request, res: Response) => {
  try {
    const uri = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
    });
    res.send(`<a href="${uri}">link</a>`);
  } catch (err) {
    res.status(400).json({ message: "Something went wrong. Try again" });
  }
});

authRouter.get("/google/callback", async (req: Request, res: Response) => {
  try {
    const { tokens } = await auth.getToken(req.query.code as string);
    auth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.getProfile({
      userId: "me",
    });
    let user = await UserModel.findOne({ email: data.emailAddress });
    if (!user) {
      user = new UserModel({
        email: data.emailAddress,
        type: "google",
        googleId: tokens.access_token,
      });
      await user.save();
    } else {
      await UserModel.updateOne(
        { email: data.emailAddress },
        { googleId: tokens.access_token }
      );
    }
    const topicName = process.env.PUBSUB_TOPIC as string;
    await serviceAccountAuth.authorize();
    const response = await gmail.users.labels.list({
      userId: "me",
    });
    const labels = response.data.labels?.map((label) => label.name);
    console.log(labels);
    await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      },
    });
    if (!labels?.includes("Interested")) {
      await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
          name: "Interested",
        },
      });
    }
    if (!labels?.includes("Not Interested")) {
      await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
          name: "Not Interested",
        },
      });
    }
    if (!labels?.includes("More Information")) {
      await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
          name: "More Information",
        },
      });
    }
    res.send("Push notifications setup complete.");
  } catch (err) {
    console.log(err);
    res.status(400).send(err);
  }
});

const msalConfig = {
  auth: {
    clientId: process.env.OUTLOOK_CLIENT_ID as string,
    authority: `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID as string}`,
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET as string,
  },
};

const pca = new ConfidentialClientApplication(msalConfig);

authRouter.get("/outlook", async (req: Request, res: Response) => {
  const authCodeUrlParameters = {
    scopes: ["https://graph.microsoft.com/.default"],
    redirectUri: `${process.env.HOST_URL}/auth/outlook/callback`,
  };

  try {
    const authUrl = await pca.getAuthCodeUrl(authCodeUrlParameters);
    res.redirect(authUrl);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error generating auth URL');
  }
});

authRouter.get("/outlook/callback", async (req: Request, res: Response) => {
  const tokenRequest = {
    code: req.query.code as string,
    scopes: ["https://graph.microsoft.com/.default"],
    redirectUri: `${process.env.HOST_URL}/auth/outlook/callback`,
  };

  try {
    const response = await pca.acquireTokenByCode(tokenRequest);
    const access_token = response.accessToken;
    const userId = response.uniqueId;
    const user = await UserModel.findOne({ email: response.account?.username });
    if(!user) {
      const newUser = new UserModel({
        email: response.account?.username,
        type: "outlook",
        outlookId: access_token,
        outlookUserId: userId,
      });
      await newUser.save();
    } else {
      await UserModel.updateOne({ email: response.account?.username }, { outlookId: access_token, outlookUserId: userId });
    }
    const client = Client.init({
      authProvider: (done) => {
        done(null, access_token); 
      },
    });
    const subscriptions = await client.api('/subscriptions').get();
    subscriptions.value.forEach(async (subscription: any) => {
      await client.api(`/subscriptions/${subscription.id}`).delete();
    });
    const subscription = {
      changeType: 'created',
      notificationUrl: `${process.env.HOST_URL}/email/outlook`,
      resource: 'me/mailFolders(\'Inbox\')/messages',
      expirationDateTime: new Date(new Date().getTime() + 4230 * 60 * 1000).toISOString(),
    };

    await client.api('/subscriptions').post(subscription);

    res.send('Authentication successful! You can close this window.');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error acquiring token');
  }
});
