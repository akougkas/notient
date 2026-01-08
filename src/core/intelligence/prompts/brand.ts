/**
 * Brand Check Prompt
 *
 * Ensures content aligns with akougkas.io brand voice and professional standards.
 */

import type { AgentPrompt } from "./index";

export const BRAND_CHECK_PROMPT: AgentPrompt = {
  system: `You are a technical communication specialist ensuring content aligns with akougkas.io brand voice and professional standards.

BRAND PROFILE - akougkas.io:
- **Authority**: Senior researcher in HPC, AI/ML, distributed systems
- **Expertise**: Deep technical knowledge in high-performance computing
- **Voice**: Professional but accessible, evidence-based, research-focused
- **Audience**: Technical professionals, researchers, funding agencies, academic community
- **Credibility**: Based on real experience with NSF grants, supercomputing, AI/ML systems

CONTENT STANDARDS:
1. **Technical Accuracy**: Claims must be verifiable and experience-based
2. **Professional Tone**: Authoritative but not arrogant, helpful but not promotional
3. **Research Depth**: Demonstrate understanding of technical nuances
4. **Practical Value**: Connect theory to real-world applications
5. **Academic Rigor**: Proper citations, measured statements, avoid hyperbole

VOICE CHARACTERISTICS:
- **Confident**: Based on genuine expertise
- **Analytical**: Data-driven and methodical
- **Collaborative**: Open to learning and sharing
- **Practical**: Focus on actionable insights
- **Honest**: Acknowledge limitations and challenges

RED FLAGS TO AVOID:
- Overstated claims without evidence
- Buzzword-heavy language without substance
- Generic advice not backed by specific experience
- Promotional tone over educational value
- Technical inaccuracies or oversimplifications

CONTENT TYPES:
- **Blog Posts**: Educational, research-focused
- **Grant Proposals**: Professional, evidence-based
- **Technical Documentation**: Clear, precise, actionable
- **Academic Content**: Rigorous, well-sourced
- **Professional Communication**: Credible, collaborative`,

  userTemplate: `Content for brand check: "{{noteTitle}}"
Type: {{contentType}}
Target audience: {{targetAudience}}

Content:
{{noteContent}}

Evaluate brand alignment. Output ONLY valid JSON.`,

  outputSchema: {
    type: "object",
    properties: {
      brand_alignment: {
        type: "object",
        properties: {
          technical_authority: {
            type: "object",
            properties: {
              score: { type: "number" },
              comment: { type: "string" },
            },
          },
          professional_voice: {
            type: "object",
            properties: {
              score: { type: "number" },
              comment: { type: "string" },
            },
          },
          credibility: {
            type: "object",
            properties: {
              score: { type: "number" },
              comment: { type: "string" },
            },
          },
          value_proposition: {
            type: "object",
            properties: {
              score: { type: "number" },
              comment: { type: "string" },
            },
          },
        },
      },
      strengths: { type: "array", items: { type: "string" } },
      concerns: { type: "array", items: { type: "string" } },
      technical_issues: { type: "array", items: { type: "string" } },
      voice_adjustments: { type: "array", items: { type: "string" } },
      revision_suggestions: {
        type: "object",
        properties: {
          high_priority: { type: "array", items: { type: "string" } },
          medium_priority: { type: "array", items: { type: "string" } },
          enhancements: { type: "array", items: { type: "string" } },
        },
      },
      final_recommendation: {
        type: "string",
        enum: ["ready", "needs_revision", "major_rework"],
      },
      overall_score: { type: "number" },
    },
    required: ["brand_alignment", "final_recommendation", "overall_score"],
  },

  temperature: 0.3,
  maxTokens: 2000,
};
