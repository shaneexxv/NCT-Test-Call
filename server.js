import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
  {
    edge: "dublin",
    region: "ie1"
  }
);

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Make test call
app.post("/test/call", async (req, res) => {
  try {
    const to = req.body.to || process.env.TEST_PHONE_NUMBER;
    if (!to || !/^\+\d{7,15}$/.test(to)) {
      return res.status(400).json({
        error: "Invalid number. Use E.164 format, e.g. +353851234567"
      });
    }

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_CALLER_ID,
      url: `${process.env.BASE_URL}/twiml`
    });

    res.json({ message: `Calling ${to}…`, sid: call.sid });
  } catch (error) {
    console.error("❌ Call error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// TwiML response
app.post("/twiml", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hello! Your Twilio test call is working perfectly.");
  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
// To run: node server.js