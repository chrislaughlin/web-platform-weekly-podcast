export type SourceId = "javascript-weekly" | "this-week-in-react";

export type Article = {
  title: string;
  url: string;
  summary: string;
  category?: string;
  fingerprint: string;
};

export type NewsletterIssue = {
  source: SourceId;
  issueNumber?: string;
  title: string;
  publishedAt?: string;
  url: string;
  contentHash: string;
  articles: Article[];
};

export type PodcastScript = {
  title: string;
  description: string;
  narration: string;
  segments: Array<{ title: string; sourceUrl: string; narration: string }>;
};

export type Run = {
  id: string;
  source: SourceId;
  requestedUrl?: string;
  requestedIssueNumber?: string;
  bypass: boolean;
  status: "running" | "completed" | "failed";
  issue?: NewsletterIssue;
  script?: PodcastScript;
  audioPath?: string;
  coverPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
