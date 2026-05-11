// AI service adapter (OpenAI-compatible, strict contract)
import axios from 'axios';
import { AIResponse, Rule } from './types';

export async function evaluateWithAI(diff: string, context: any, rules: Rule[]): Promise<AIResponse> {
  // TODO: Implement prompt construction and call to AI provider
  // Strictly validate response shape before returning
  throw new Error('AI evaluation not yet implemented');
}
