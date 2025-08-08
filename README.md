# Job Scraper

Simple API-based job scraper that finds delivery driver jobs from multiple services.

## Features

- ✅ **API-based scraping** - No browser needed
- ✅ **Multiple services** - Instacart, DoorDash, Grubhub, etc.
- ✅ **Time filtering** - Only jobs posted within last 4 hours
- ✅ **Anti-detection** - Uses Decodo API service
- ✅ **CSV & JSON output** - Easy to analyze results

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Run the scraper**
   ```bash
   npm start
   ```

## Configuration

Edit `services.json` to enable/disable services or modify search parameters.

## Output

Results are saved in the `output/` directory:
- Individual service files: `{service}_jobs_{timestamp}.csv/json`
- Combined results: `all_services_jobs_{timestamp}.csv/json`

## How it Works

1. Reads enabled services from `services.json`
2. For each service, builds Google Jobs search URL
3. Fetches HTML via Decodo API
4. Parses job listings using CSS selectors
5. Filters jobs by posting time (last 4 hours)
6. Saves results to CSV and JSON files

## Requirements

- Node.js 16+
- Decodo API access (configured in the code)
- Internet connection

That's it! No browser installation, no proxy setup needed.