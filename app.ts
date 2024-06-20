import axios from "axios";
import { Client } from "@notionhq/client";
import OpenAI from "openai";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

// Initialize the Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_API_TOKEN || "");

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Notion API
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID || "";

// Function to fetch webpage content
const fetchWebpageContent = async (url) => {
  const response = await axios.get(url);
  return await response.data.toString();
};

// Function to extract metadata using OpenAI
const extractMetadata = async (content) => {
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant that extracts the title, authors, and tags from article content.",
      },
      {
        role: "user",
        content: `Extract the title, authors, and tags from this article content:\n\n${content}\n\nFormat:\nTitle: <title>\nAuthors: <authors>\nTags: <tags>`,
      },
    ],
    max_tokens: 150,
    temperature: 0.7,
  });

  const text = response.choices[0].message.content?.trim();
  if (!text) {
    throw new Error("Failed to extract metadata from the article content.");
  }
  const lines = text.split("\n");
  const title = lines[0].replace("Title: ", "");
  const authors = lines[1].replace("Authors: ", "");
  const tags = lines[2].replace("Tags: ", "");

  return { title, authors, tags };
};

// Function to fetch existing multiselect options from Notion
const fetchMultiselectOptions = async (propertyId: string) => {
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const property = database.properties[propertyId];
  // @ts-ignore
  return property.multi_select.options;
};

// Function to create a new Notion database item
const createNotionItem = async (url, title, authors, tags) => {
  const existingAuthors = await fetchMultiselectOptions("Authors");
  const existingTags = await fetchMultiselectOptions("Tags");

  const formatOptions = (
    names: string,
    existingOptions: { id: string; name: string }[]
  ) => {
    return names.split(",").map((name) => {
      const trimmedName = name.trim();
      const existingOption = existingOptions.find(
        (option) => option.name.toLowerCase() === trimmedName.toLowerCase()
      );
      return existingOption
        ? { name: existingOption.name }
        : { name: trimmedName };
    });
  };

  const formattedAuthors = formatOptions(authors, existingAuthors);
  const formattedTags = formatOptions(tags, existingTags);

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      URL: {
        url,
      },
      Title: {
        title,
      },
      Authors: {
        multi_select: formattedAuthors,
      },
      Tags: {
        multi_select: formattedTags,
      },
    },
  });
};

// Telegram bot command to handle URLs
bot.on("text", async (ctx) => {
  const url = ctx.message.text;
  const username = ctx.message.from.username;

  if (username !== process.env.AUTHORIZED_USER) {
    ctx.reply("You are not authorized to use this bot.");
    return;
  }

  if (!url.startsWith("http")) {
    ctx.reply("Please send a valid URL.");
    return;
  }

  try {
    const content = await fetchWebpageContent(url);
    const { title, authors, tags } = await extractMetadata(content);
    console.log({ title, authors, tags });
    await createNotionItem(url, title, authors, tags);
    ctx.reply(
      `Article added to Notion database!\n\nTitle: ${title}\nAuthors: ${authors}\nTags: ${tags}`
    );
  } catch (error) {
    console.error(error);
    ctx.reply("Failed to process the article.");
  }
});

// Start the bot
bot.launch();
console.log("Bot started");
