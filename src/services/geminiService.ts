/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { TransitMetadata } from "../types";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || '' 
});

const SYSTEM_PROMPT = `
You are a Real-Time Transit Data Extractor for Tamil Nadu.
Input: You will receive two images (one full bus view, one license plate crop).

Task:
1. Read the TN Registration Plate from the crop (strictly alphanumeric, e.g., TN-xx-xxxx).
2. Read the LED Destination Board from the full bus.
3. Identify the Route Number and the Final Destination text. 
4. Identify the Operator (TNSTC, SETC, or Private).
5. Private Branding: If the operator is "Private", identify the specific name of the bus service (e.g., "KPN", "Velas", "National"). This branding is usually prominent on the front, sides, or glass.
6. Constraint: If the text is in Tamil, translate the destination to English (e.g., "மதுரை" -> "Madurai").
7. Validation: District codes 01 to 99 are valid for Tamil Nadu. If code > 99 or prefix != TN, is_tn_bus = false.
8. Low Light: If imagery is grainy, use bus color (Green/Yellow for local, Blue/White for interstate) and logo to assist.

Strict Rule: Return ONLY a JSON object. No conversation.
`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    plate: { type: Type.STRING, description: "The registration number of the vehicle" },
    route: { type: Type.STRING, description: "The route number displayed on the LED board" },
    destination: { type: Type.STRING, description: "The final destination text (translated to English if in Tamil)" },
    operator: { 
      type: Type.STRING, 
      enum: ["TNSTC", "SETC", "Private", "Unknown"],
      description: "The transport operator identified from logo or livery" 
    },
    bus_name: { type: Type.STRING, description: "The specific branding name for private buses (e.g., KPN, National). Null if government bus." },
    is_tn_bus: { type: Type.BOOLEAN, description: "Whether the bus is registered in Tamil Nadu" },
    confidence: { type: Type.NUMBER, description: "Extraction confidence score 0.0 - 1.0" }
  },
  required: ["plate", "destination", "is_tn_bus"]
};

export async function extractTransitData(
  fullImageBase64: string,
  plateCropBase64: string
): Promise<TransitMetadata> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("API_KEY_MISSING: Gemini API key is not configured in the environment.");
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { text: SYSTEM_PROMPT },
          {
            inlineData: {
              data: fullImageBase64.split(',')[1] || fullImageBase64,
              mimeType: "image/jpeg"
            }
          },
          {
            inlineData: {
              data: plateCropBase64.split(',')[1] || plateCropBase64,
              mimeType: "image/jpeg"
            }
          }
        ]
      },
      config: {
        temperature: 0.0,
        responseMimeType: "application/json",
        responseSchema: responseSchema
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error("EMPTY_RESPONSE: The model failed to generate a response for these images.");
    }

    try {
      const result = JSON.parse(text);
      return result as TransitMetadata;
    } catch (e) {
      throw new Error("PARSING_FAILURE: The extraction agent returned malformed data. Please try again with clearer images.");
    }
  } catch (error: any) {
    // Check for common API errors
    if (error.message?.includes('quota')) {
      throw new Error("QUOTA_EXCEEDED: API limit reached. Please try again later.");
    }
    if (error.message?.includes('API key')) {
      throw new Error("API_KEY_INVALID: The configured Gemini API key is invalid or restricted.");
    }
    
    // Re-throw if it's already one of our custom messages, otherwise wrap it
    if (error.message?.includes(': ')) {
      throw error;
    }
    throw new Error(`EXTRACTION_ERROR: ${error.message || 'An unexpected error occurred during visual analysis.'}`);
  }
}
