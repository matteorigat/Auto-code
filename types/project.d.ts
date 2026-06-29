export interface ProjectMetadata {
  path: string;
  desc: string;
}

export interface Story {
  id: string; // In Notion, this maps to storyId or blockId
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes?: string;
  pageId?: string;
  blockId?: string;
  excluded?: boolean;
}

export interface PRD {
  codebasePatterns: string;
  stories: Story[];
}
