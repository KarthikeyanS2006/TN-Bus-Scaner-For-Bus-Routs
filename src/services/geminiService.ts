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
2. TN Validation Rule:
   - The plate MUST start with "TN".
   - It MUST be followed by a valid district code between "01" and "99".
   - If either of these conditions is NOT met (e.g., starts with PY, KA, or code is 00 or > 99), you MUST set "is_tn_bus" to false.
3. Read the LED Destination Board from the full bus.
4. Identify the Route Number and the Final Destination text. 
5. Identify the Operator (TNSTC, SETC, or Private).
6. Private Branding: If the operator is "Private", identify the specific name of the bus service (e.g., "KPN", "Velas", "National").
7. Constraint: If the text is in Tamil, translate the destination to English.
8. Low Light: If imagery is grainy, use bus color and logo to assist.

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

    if (!response) {
      throw new Error("EMPTY_RESPONSE: The model failed to generate a response for these images.");
    }

    const text = response.text;
    if (!text) {
      throw new Error("EMPTY_RESPONSE: No metadata could be extracted from the provided source.");
    }

    try {
      const result = JSON.parse(text);
      return result as TransitMetadata;
    } catch (e) {
      throw new Error("PARSING_FAILURE: The extraction agent returned malformed data. Please try again with clearer images.");
    }
  } catch (error: any) {
    // Check for specific Gemini API errors
    const errorMsg = error.message?.toLowerCase() || '';
    
    if (errorMsg.includes('quota') || errorMsg.includes('429')) {
      throw new Error("QUOTA_EXCEEDED: Gemini API limit reached. Please wait a minute or check your plan.");
    }
    
    if (errorMsg.includes('api key') || errorMsg.includes('401') || errorMsg.includes('403')) {
      throw new Error("API_KEY_INVALID: The configured Gemini API key is missing, invalid, or restricted.");
    }

    // Re-proxy our existing codes
    if (error.message?.includes(': ')) {
      throw error;
    }

    throw new Error(`EXTRACTION_ERROR: ${error.message || 'An unexpected error occurred during visual analysis.'}`);
  }
}
