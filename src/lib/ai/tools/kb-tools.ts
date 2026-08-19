// Knowledge base lookup tools — lets the AI retrieve electronics articles.
//
// The AI can:
//   - kb.lookup: get a specific article by ID
//   - kb.search: free-text search across all articles
//   - kb.listByCategory: list articles in a category
//   - kb.related: get related articles for a given article

import {
  getArticle,
  searchArticles,
  getArticlesByCategory,
  getRelatedArticles,
  KB_ARTICLES,
  KB_CATEGORIES,
  type KBArticle,
} from '../knowledge/knowledge-base';
import type { Tool, ToolContext } from './types';

// Helper: format an article for the AI (concise version — full body is long)
function formatArticleForAI(article: KBArticle, includeBody = false): object {
  return {
    id: article.id,
    title: article.title,
    category: article.category,
    tags: article.tags,
    summary: article.summary,
    ...(includeBody ? { body: article.body } : {}),
    related: article.related || [],
    seeAlso: article.seeAlso || [],
  };
}

export const kbLookupTool: Tool = {
  name: 'kb.lookup',
  category: 'Knowledge Base',
  description: 'Look up a specific knowledge base article by its ID. Returns the full article including body. Use this when the user asks about a specific concept (e.g. "explain Ohm\'s Law") or when you want to cite a reference.',
  parameters: {
    type: 'object',
    properties: {
      articleId: {
        type: 'string',
        description: 'The article ID (e.g. "ohms-law", "555-timer", "floating-node"). Use kb.search first if you don\'t know the exact ID.',
      },
    },
    required: ['articleId'],
  },
  execute(args: { articleId: string }, _ctx: ToolContext) {
    const article = getArticle(args.articleId);
    if (!article) {
      return {
        ok: false,
        error: `Article "${args.articleId}" not found. Use kb.search to find articles by topic.`,
        result: {
          availableArticles: KB_ARTICLES.map(a => ({ id: a.id, title: a.title })),
        },
      };
    }
    return { ok: true, result: formatArticleForAI(article, true) };
  },
};

export const kbSearchTool: Tool = {
  name: 'kb.search',
  category: 'Knowledge Base',
  description: 'Search the electronics knowledge base by free-text query. Returns up to 5 matching articles with summaries. Use this when the user asks a question and you want to find relevant reference material.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g. "how does a capacitor work", "LED resistor calculation", "floating node error").',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 5).',
      },
    },
    required: ['query'],
  },
  execute(args: { query: string; limit?: number }, _ctx: ToolContext) {
    const results = searchArticles(args.query, args.limit || 5);
    if (results.length === 0) {
      return {
        ok: true,
        result: {
          message: `No articles found for "${args.query}".`,
          suggestion: 'Try different keywords, or use kb.listByCategory to browse all categories.',
          categories: KB_CATEGORIES,
        },
      };
    }
    return {
      ok: true,
      result: {
        query: args.query,
        results: results.map(a => formatArticleForAI(a)),
        count: results.length,
      },
    };
  },
};

export const kbListByCategoryTool: Tool = {
  name: 'kb.listByCategory',
  category: 'Knowledge Base',
  description: 'List all knowledge base articles in a given category. Use this when the user wants to browse available topics.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Category ID. One of: concepts, passives, semiconductors, ic, sources, analysis, troubleshooting, design-patterns, pcb.',
        enum: ['concepts', 'passives', 'semiconductors', 'ic', 'sources', 'analysis', 'troubleshooting', 'design-patterns', 'pcb'],
      },
    },
    required: ['category'],
  },
  execute(args: { category: string }, _ctx: ToolContext) {
    const articles = getArticlesByCategory(args.category as KBArticle['category']);
    return {
      ok: true,
      result: {
        category: args.category,
        count: articles.length,
        articles: articles.map(a => formatArticleForAI(a)),
      },
    };
  },
};

export const kbRelatedTool: Tool = {
  name: 'kb.related',
  category: 'Knowledge Base',
  description: 'Get related articles for a given article. Use this after kb.lookup to suggest further reading.',
  parameters: {
    type: 'object',
    properties: {
      articleId: {
        type: 'string',
        description: 'The article ID to find related articles for.',
      },
    },
    required: ['articleId'],
  },
  execute(args: { articleId: string }, _ctx: ToolContext) {
    const related = getRelatedArticles(args.articleId);
    return {
      ok: true,
      result: {
        articleId: args.articleId,
        relatedCount: related.length,
        related: related.map(a => formatArticleForAI(a)),
      },
    };
  },
};

export const kbListCategoriesTool: Tool = {
  name: 'kb.listCategories',
  category: 'Knowledge Base',
  description: 'List all knowledge base categories with article counts. Use this to help the user browse the library.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute(_args, _ctx: ToolContext) {
    return {
      ok: true,
      result: {
        categories: KB_CATEGORIES.map(cat => ({
          ...cat,
          articleCount: getArticlesByCategory(cat.id).length,
        })),
        totalArticles: KB_ARTICLES.length,
      },
    };
  },
};
