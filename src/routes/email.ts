import express, { Request, Response } from "express";
import { Router } from "express";
import dotenv from "dotenv";
import { redis } from "../utils/redis";
import { Queue, Worker } from "bullmq";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY as string);
import { ConfidentialClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";

import { UserModel } from "../models/User";
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
dotenv.config();

const auth = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const gmail = google.gmail({ version: "v1", auth });

const emailQueue = new Queue("email", { connection: redis });

export const emailRouter: Router = Router();

emailRouter.post("/gmail", async (req: Request, res: Response) => {
  try {
    const dataBuffer = Buffer.from(req.body.message.data, "base64");
    const data = JSON.parse(dataBuffer.toString("utf-8"));
    const email = data.emailAddress;
    const historyId = data.historyId;
    res.status(204).send();
    await emailQueue.add("gmail", { email, historyId });
  } catch (err) {
    console.log(err);
  }
});

const worker = new Worker(
  "email",
  async (job) => {
    console.log("Processing job:", job.id);
    const { email, historyId } = job.data;
    const user = await UserModel.findOne({ email });
    if (!user) {
      return;
    }
    if (user?.historyId) {
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${email}/history?startHistoryId=${user.historyId}&historyTypes=messageAdded`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${user?.googleId}`,
          },
        }
      );
      const history = await response.json();
      history.history.forEach(async (hist: any) => {
        hist.messagesAdded.forEach(async (message: any) => {
          if (message.message.labelIds.includes("UNREAD")) {
            auth.setCredentials({ access_token: user.googleId });
            const res = await gmail.users.threads.get({
              userId: email,
              id: message.message.threadId,
            });
            const messages: Array<any> = res.data.messages || [];
            if (messages.length === 1) {
              const message = messages[0];
              const headers = message.payload.headers;
              const subject = headers.find(
                (header: any) => header.name === "Subject"
              );
              const from = headers.find(
                (header: any) => header.name === "From"
              );
              const to = headers.find((header: any) => header.name === "To");
              const date = headers.find(
                (header: any) => header.name === "Date"
              );
              console.log("Subject:", subject.value);
              console.log("From:", from.value);
              console.log("To:", to.value);
              console.log("Date:", date.value);
              console.log("Message:", message.snippet);
              const prompt = `Generate a proffesional response. your response will be sent without any changes. You are an assistant replying to an email from ${from.value} to ${to.value} with the subject ${subject.value}. The email reads: ${message.snippet}.`;
              const modelResult = await model.generateContent(prompt);
              const modelResponse = modelResult.response;
              const modelText = modelResponse.text();
              let replyPayload = [
                'Content-Type: text/plain; charset="UTF-8"\n',
                "MIME-Version: 1.0\n",
                "Content-Transfer-Encoding: 7bit\n",
                "to: ",
                from.value,
                "\n",
                "from: me\n",
                "subject: " + "Automated response" + "\n",
                "In-Reply-To: " + message.id + "\n",
                "References: " + message.id + "\n",
                "\n",
                modelText,
              ].join("");

              const rep = await gmail.users.messages.send({
                userId: email,
                requestBody: {
                  raw: Buffer.from(replyPayload)
                    .toString("base64")
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
                    .replace(/=+$/, ""),
                  threadId: message.threadId,
                },
              });
              let label = "More Information";
              if (modelText.includes("Interested")) {
                label = "Interested";
              } else if (modelText.includes("Not Interested")) {
                label = "Not Interested";
              }
              const getLabels = await gmail.users.labels.list({
                userId: email,
              });
              let labelId = "INBOX";
              getLabels.data.labels?.forEach((l: any) => {
                if (l.name === label) {
                  labelId = l.id;
                }
              });
              await gmail.users.messages.modify({
                userId: email,
                id: message.id,
                requestBody: {
                  addLabelIds: [labelId],
                },
              });
            }
          }
        });
      });
    }
    await UserModel.updateOne({ email }, { historyId });
  },
  { connection: redis }
);

const msalConfig = {
  auth: {
    clientId: process.env.OUTLOOK_CLIENT_ID as string,
    authority: `https://login.microsoftonline.com/${
      process.env.OUTLOOK_TENANT_ID as string
    }`,
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET as string,
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

emailRouter.post("/outlook", async (req: Request, res: Response) => {
  if (req.query && req.query.validationToken) {
    res.send(req.query.validationToken);
  } else {
    res.sendStatus(200);
    const notification = req.body.value[0];

    const resource = notification.resource;
    let userId: string = resource.split("/")[1];
    let messageId: string = resource.split("/")[3];
    if (userId && messageId) {
      try {
        const user = await UserModel.findOne({ outlookUserId: userId });
        if (!user) {
          return;
        }
        const accessToken: any = user?.outlookId;
        const client = Client.init({
          authProvider: (done) => {
            done(null, accessToken);
          },
        });
        const message: any = await client
          .api("/me/messages/" + messageId)
          .get();

        const isSent = message.sender.emailAddress.address === user.email;
        if (!isSent) {
          const subject = message.subject;
          const content = message.bodyPreview;
          const from = message.sender.emailAddress.address;
          const prompt = `Generate a proffesional response. your response will be sent without any changes. You are an assistant replying to an email from ${from} with the subject ${subject}. The email reads: ${content}.`;
          const modelResult = await model.generateContent(prompt);
          const modelResponse = modelResult.response;
          const modelText = modelResponse.text();
          const reply = {
            message: {
              toRecipients: [message.sender],
            },
            comment: modelText,
          };
          const respo = await client.api("/me/messages/" + messageId + "/reply").post(reply);
          console.log(respo);
        }
      } catch (error) {
        console.error(`Error fetching message details: ${error}`);
      }
    }
  }
});
