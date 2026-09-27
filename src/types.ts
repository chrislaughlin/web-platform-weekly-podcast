export type SourceId = "javascript-weekly" | "this-week-in-react";
export type RunSource = SourceId | "both";

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
  mainTopics?: string[];
  segments: Array<{
    storyId?: string;
    title: string;
    sourceUrl: string;
    sourceUrls?: string[];
    description: string;
    whyItMatters: string;
    followUps: string;
    narration: string;
  }>;
};

export type Run = {
  id: string;
  source: RunSource;
  requestedUrl?: string;
  requestedUrls?: string[];
  requestedIssueNumber?: string;
  artifactFolder?: string;
  weekLabel?: string;
  bypass: boolean;
  status: "running" | "completed" | "failed";
  issue?: NewsletterIssue;
  issues?: NewsletterIssue[];
  script?: PodcastScript;
  audioPath?: string;
  coverPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
