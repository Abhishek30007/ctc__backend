import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',  // Local development
    'https://ctc-client-798p.vercel.app'  // Deployed frontend
  ],
  credentials: true
}));
app.use(express.json());

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Helper function to clean and parse JSON from AI response
function parseAIResponse(text) {
  try {
    // Remove markdown code blocks if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '');
    cleaned = cleaned.replace(/^```\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/i, '');
    cleaned = cleaned.trim();

    // Parse JSON
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('JSON parsing error:', error);
    console.error('Raw response:', text);
    throw new Error('Failed to parse AI response as JSON');
  }
}

// Salary calculation endpoint
app.post('/api/salary', async (req, res) => {
  try {
    const { company, position, ctc, location } = req.body;

    // Validate required fields
    if (!company || typeof company !== 'string' || company.trim() === '') {
      return res.status(400).json({
        error: 'Company name is required'
      });
    }

    if (!position || typeof position !== 'string' || position.trim() === '') {
      return res.status(400).json({
        error: 'Job role/position is required'
      });
    }

    if (!ctc || typeof ctc !== 'string' || ctc.trim() === '') {
      return res.status(400).json({
        error: 'Annual CTC is required'
      });
    }

    if (!location || typeof location !== 'string' || location.trim() === '') {
      return res.status(400).json({
        error: 'Work location is required'
      });
    }

    // Check if API key is loaded
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set in environment variables');
      return res.status(500).json({
        error: 'Server configuration error: API key not found'
      });
    }

    // Construct the detailed prompt with AI Compensation Researcher logic
    const prompt = `You are a Senior Compensation Analyst for Top Tier Tech Companies in India.

**PHASE 1: THE REALITY CHECK & DEEP DIVE (Research Phase)**

User Input: **Company:** ${company.trim()}, **Role:** ${position.trim()}, **CTC:** ${ctc.trim()}, **Location:** ${location.trim()}

Before calculating any taxes, you MUST:

1. **Reality Check:** Search for the market standard salary for **${position.trim()}** at **${company.trim()}** in India.
   - Compare the user's input **CTC: ${ctc.trim()}** against the market standard.
   - **The Mismatch Rule:** If the user's input CTC is **less than 50%** of the typical minimum for that role, or if the role/salary combination is effectively impossible (e.g., 'Google Level 2/SDE' at 7 LPA, when the minimum is usually 25 LPA+), you must **REJECT** the calculation.

2. **Compensation Structure Research:** If the salary is realistic, use the \`googleSearch\` tool to find the specific **Compensation Structure** for this company and role in India.
   - **Key Question:** What is the typical **Base Salary vs. Stock (RSU)** split for **${company.trim()}** at this CTC level?
   - **Examples:** 
     * Amazon CTC is often 50% Stocks (vested annually, not monthly)
     * Netflix is 100% Cash
     * Google is ~60% Cash + 40% Stock
     * Microsoft is ~70% Cash + 30% Stock
   - **Deduce:** Estimate the **Fixed Base Salary** (Cash Component) from the Total CTC.
   - Also estimate: Stock Component (RSUs) and Year-end Bonus if applicable.

**PHASE 2: THE CALCULATION (Cash Only)**

If the salary passes reality check, calculate the monthly in-hand salary based **ONLY on the estimated Fixed Base Salary**, not the Total CTC.

- Apply Indian Tax Regime (New) on the Base Salary.
- Deduct PF (12% of Basic, capped at 1800 if basic > 15k), Professional Tax (based on ${location.trim()} state rules), and other applicable deductions.
- **ESI:** Only applicable if Gross Monthly Salary < 21,000. Otherwise \`null\`.

**PHASE 3: THE OUTPUT (Structured Intelligence)**

Return **ONLY** a raw JSON object (no markdown, no backticks). Choose one of these two formats:

**FORMAT A: (Use this if the salary is IMPOSSIBLE/UNREALISTIC)**
{
  "status": "mismatch",
  "research_findings": null,
  "monthly_breakdown": null,
  "analysis": "⚠️ REALITY CHECK FAILED: A ${position.trim()} at ${company.trim()} typically earns between ₹[Min] - ₹[Max] LPA. Your input of ₹${ctc.trim()} is significantly below the market standard. This might be an internship stipend or a contract role, not a full-time ${position.trim()} position.",
  "notes": null
}

**FORMAT B: (Use this if the salary is REALISTIC - proceed with calculation)**
{
  "status": "success",
  "research_findings": {
    "company_policy": "Found that ${company.trim()} typically pays ~[X]% of CTC as RSUs which are not part of monthly salary.",
    "estimated_base_salary": number (The cash part in LPA),
    "estimated_stock_component": number (The RSU part in LPA),
    "estimated_bonus": number (Year-end bonus in LPA, can be 0)
  },
  "monthly_breakdown": {
    "gross_monthly_cash": number (Base Salary / 12),
    "deductions": {
      "pf": number,
      "tax_monthly": number,
      "professional_tax": number,
      "esi": number or null,
      "other_deductions": number or null
    },
    "final_in_hand_salary": number (The REAL monthly amount)
  },
  "notes": "A short explanation: 'Note: Your CTC is ₹[CTC]L, but ~₹[Stock]L is likely in Stocks/Bonuses paid annually. Hence your monthly bank credit is lower than expected.'"
}

**Important:** Always use Google Search to find accurate, real-time compensation structure data for the specific company and role.`;

    console.log(`Calculating salary breakdown for: ${company.trim()} - ${position.trim()} - ${ctc.trim()} - ${location.trim()}`);

    // Try multiple models in order of preference
    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-2.0-flash-exp',
      'gemini-pro'
    ];

    console.log(`Available models to try: ${modelsToTry.join(', ')}`);

    let lastError = null;
    let salaryData = null;
    let successfulModel = null;

    // Try with Google Search Grounding first (for real-time company policies)
    for (const modelName of modelsToTry) {
      try {
        console.log(`Trying model: ${modelName} with Google Search Grounding`);
        const model = genAI.getGenerativeModel({
          model: modelName,
          tools: [{ googleSearch: {} }]
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const rawResponse = response.text().trim();

        // Parse the JSON response
        salaryData = parseAIResponse(rawResponse);
        successfulModel = `${modelName} (with Google Search)`;
        console.log(`✓ Successfully calculated salary breakdown using ${modelName}`);
        break;
      } catch (error) {
        console.log(`✗ Model ${modelName} with Google Search failed: ${error.message}`);
        lastError = error;
        // Continue to next model
      }
    }

    // If Google Search Grounding failed, try without it
    if (!salaryData) {
      console.log('Trying models without Google Search Grounding...');
      for (const modelName of modelsToTry) {
        try {
          console.log(`Trying model: ${modelName} (without Google Search Grounding)`);
          const model = genAI.getGenerativeModel({
            model: modelName
          });

          const result = await model.generateContent(prompt);
          const response = await result.response;
          const rawResponse = response.text().trim();

          // Parse the JSON response
          salaryData = parseAIResponse(rawResponse);
          successfulModel = modelName;
          console.log(`✓ Successfully calculated salary breakdown using ${modelName}`);
          break;
        } catch (error) {
          console.log(`✗ Model ${modelName} failed: ${error.message}`);
          lastError = error;
          // Continue to next model
        }
      }
    }

    if (!salaryData) {
      throw lastError || new Error('All models failed. Please check your API key and available models.');
    }

    // Check if salary validation failed (mismatch status)
    if (salaryData.status === 'mismatch') {
      console.log('⚠️ Salary reality check failed - mismatch detected');
      return res.json({
        success: false,
        status: 'mismatch',
        company: company.trim(),
        position: position.trim(),
        ctc: ctc.trim(),
        location: location.trim(),
        analysis: salaryData.analysis || salaryData.notes,
        research_findings: null,
        monthly_breakdown: null,
        notes: null
      });
    }

    // Salary validation passed - proceed with normal response
    if (salaryData.status === 'success') {
      console.log('✓ Salary reality check passed - proceeding with calculation');
      console.log('Research findings:', salaryData.research_findings);
    }

    // Add input details to response
    res.json({
      success: salaryData.status === 'success',
      company: company.trim(),
      position: position.trim(),
      ctc: ctc.trim(),
      location: location.trim(),
      status: salaryData.status,
      research_findings: salaryData.research_findings || null,
      monthly_breakdown: salaryData.monthly_breakdown || null,
      notes: salaryData.notes || null
    });

  } catch (error) {
    console.error('Error fetching salary estimate:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });

    // Handle specific Gemini API errors
    if (error.message?.includes('API_KEY') || error.message?.includes('API key')) {
      return res.status(500).json({
        error: 'Invalid or missing Gemini API key. Please check your API key.'
      });
    }

    if (error.message?.includes('404') || error.message?.includes('not found')) {
      return res.status(500).json({
        error: 'Model not available. Please check your API key has access to Gemini models. Try using gemini-pro model.'
      });
    }

    res.status(500).json({
      error: `Failed to fetch salary estimate: ${error.message || 'Unknown error'}`
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

