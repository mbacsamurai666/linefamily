import type { FamilyContext, IntentParser, ParseResult } from './types.js';

export interface ChainOptions {
  /**
   * Results at or above this confidence stop the chain. Below it, the next
   * parser gets a turn — this threshold is the dial that trades LLM spend
   * against how often a rule-parsed guess is accepted as-is.
   */
  threshold?: number;
  onParserUsed?: (name: string, result: ParseResult) => void;
}

/**
 * Runs parsers in order and stops at the first confident answer.
 *
 * Disabling AI is not a code path here — it is simply constructing the chain
 * without the LLM parser in it. That is what keeps "the system works fully
 * with AI off" true rather than aspirational.
 */
export class ChainedIntentParser implements IntentParser {
  readonly name = 'chain';
  private readonly threshold: number;

  constructor(
    private readonly parsers: IntentParser[],
    private readonly options: ChainOptions = {},
  ) {
    this.threshold = options.threshold ?? 0.7;
  }

  async parse(text: string, ctx: FamilyContext): Promise<ParseResult> {
    let best: ParseResult = { kind: 'unknown' };

    for (const parser of this.parsers) {
      const result = await parser.parse(text, ctx);
      this.options.onParserUsed?.(parser.name, result);

      if (result.kind === 'unknown') continue;
      if (result.confidence >= this.threshold) return result;

      if (best.kind === 'unknown' || result.confidence > best.confidence) {
        best = result;
      }
    }

    return best;
  }
}
