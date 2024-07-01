// @ts-nocheck
import axios from "axios";
import { Client } from "@notionhq/client";
import OpenAI from "openai";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import dotenv from "dotenv";
dotenv.config();

type State = {
  [username: string]: {
    url: string;
    title: string;
    authors: string;
    tags: string;
  } | null;
};

const userState: State = {};
const editState: State = {};

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
  const metadata = {
    title: "",
    authors: "",
    tags: "",
  };

  lines.forEach((line) => {
    if (line.startsWith("Title: ")) {
      metadata.title = line.replace("Title: ", "").trim();
    } else if (line.startsWith("Authors: ")) {
      metadata.authors = line.replace("Authors: ", "").trim();
    } else if (line.startsWith("Tags: ")) {
      metadata.tags = line.replace("Tags: ", "").trim();
    }
  });

  return metadata;
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

  const formattedAuthors = authors
    ? formatOptions(authors, existingAuthors)
    : [];
  const formattedTags = tags ? formatOptions(tags, existingTags) : [];

  const properties: { Name: any; Link: any; Authors?: any; Tags?: any } = {
    Name: {
      title: [
        {
          text: {
            content: title,
          },
        },
      ],
    },
    Link: {
      url: url,
    },
  };

  if (formattedAuthors.length > 0) {
    properties.Authors = {
      multi_select: formattedAuthors,
    };
  }

  if (formattedTags.length > 0) {
    properties.Tags = {
      multi_select: formattedTags,
    };
  }

  await notion.pages
    .create({
      parent: { database_id: databaseId },
      properties: properties,
    })
    .then((page) => {
      return page;
    });
};

// Telegram bot command to handle URLs
bot.on(message("text"), async (ctx) => {
  const url = ctx.message.text;
  const username = ctx.message.from.username || "";

  if (username !== process.env.AUTHORIZED_USER) {
    ctx.reply("You are not authorized to use this bot.");
    return;
  }

  if (!url.startsWith("http")) {
    ctx.reply("Please send a valid URL.");
    return;
  }

  try {
    await ctx.reply("Message received.");
    await ctx.reply("Getting web content...");
    const content = await fetchWebpageContent(url);

    await ctx.reply("Parsing metadata...");
    const { title, authors, tags } = await extractMetadata(content);
    console.log({ title, authors, tags });

    // Save state
    userState[username] = { url, title, authors, tags };
    editState[username] = null; // Reset edit state

    await ctx.reply(
      `Parsed Metadata:\n\nTitle: ${title}\nAuthors: ${authors}\nTags: ${tags}\n\nIs this correct?`,
      Markup.inlineKeyboard([
        Markup.button.callback("Yes", `confirm_yes|${username}`),
        Markup.button.callback("No", `confirm_no|${username}`),
      ])
    );
  } catch (error) {
    console.error(error);
    ctx.reply("Failed to process the article.");
  }
});

bot.action(/confirm_yes\|(.+)/, async (ctx) => {
  const username = ctx.match[1];
  const { url, title, authors, tags } = userState[username];
  await ctx.reply("Submitting to Notion...");

  try {
    const notionPage = await createNotionItem(url, title, authors, tags);
    await ctx.reply(`Saved successfully!`);
    // Cleanup state
    delete userState[username];
    delete editState[username];
  } catch (error) {
    console.error(error);
    ctx.reply("Failed to save the article to Notion.");
  }
});

bot.action(/confirm_no\|(.+)/, async (ctx) => {
  const username = ctx.match[1];
  if (!userState[username]) {
    ctx.reply("Issue reading state.");
    return;
  }
  const { url, title, authors, tags } = userState[username];
  await ctx.reply(
    "Which part would you like to edit?",
    Markup.inlineKeyboard([
      Markup.button.callback("Title", `edit_title|${username}`),
      Markup.button.callback("Authors", `edit_authors|${username}`),
      Markup.button.callback("Tags", `edit_tags|${username}`),
    ])
  );
});

bot.action(/edit_title\|(.+)/, async (ctx) => {
  const username = ctx.match[1];
  await ctx.reply("Please provide the new title.");
  editState[username] = "title";
});

bot.action(/edit_authors\|(.+)/, async (ctx) => {
  const username = ctx.match[1];
  await ctx.reply("Please provide the new authors, separated by commas.");
  editState[username] = "authors";
});

bot.action(/edit_tags\|(.+)/, async (ctx) => {
  const username = ctx.match[1];
  await ctx.reply("Please provide the new tags, separated by commas.");
  editState[username] = "tags";
});

bot.on(message("text"), async (ctx) => {
  const username = ctx.message.from.username || "";
  if (editState[username]) {
    const newValue = ctx.message.text;
    userState[username][editState[username]] = newValue;
    editState[username] = null;

    const { title, authors, tags } = userState[username];
    await ctx.reply(
      `Updated Metadata:\n\nTitle: ${title}\nAuthors: ${authors}\nTags: ${tags}\n\nIs this correct?`,
      Markup.inlineKeyboard([
        Markup.button.callback("Yes", `confirm_yes|${username}`),
        Markup.button.callback("No", `confirm_no|${username}`),
      ])
    );
  }
});

// Start the bot
bot.launch();
console.log("Bot started");
