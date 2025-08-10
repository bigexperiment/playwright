/**
 * Job Scraper - API-based scraping using Decodo service
 * Simple, fast, and efficient - no browser needed
 */

require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { JSDOM } = require('jsdom');

const CONFIG = {
    outputDir: 'output',
    maxJobs: 100,
    apiEndpoint: 'https://scraper-api.decodo.com/v2/scrape',
    apiAuth: process.env.API_AUTH,
    supabase: {
        url: process.env.SUPABASE_URL,
        serviceKey: process.env.SUPABASE_SERVICE_KEY
    },
    delays: {
        betweenRequests: 2000 // 2 seconds between API calls
    }
};

class JobScraper {
    constructor() {
        this.jobsData = [];
        this.services = [];
        this.maxHoursWindow = Number(process.env.MAX_HOURS) > 0 ? Number(process.env.MAX_HOURS) : 6;
        
        fs.ensureDirSync(CONFIG.outputDir);
        this.loadServices();
    }

    loadServices() {
        try {
            const servicesPath = path.join(__dirname, 'services.json');
            const servicesData = fs.readJsonSync(servicesPath);
            this.services = servicesData.services.filter(service => service.enabled);
            console.log(`📋 Loaded ${this.services.length} enabled services`);
        } catch (error) {
            console.log(`❌ Error loading services.json: ${error.message}`);
            process.exit(1);
        }
    }

    buildSimpleUrl(serviceName) {
        // Use simplified Google search format
        const baseUrl = 'https://www.google.com/search';
        const query = `${serviceName} jobs UNITED STATES since yesterday`;
        const params = new URLSearchParams({
            q: query,
            udm: '8'  // Jobs filter
        });
        
        return `${baseUrl}?${params.toString()}`;
    }

    async fetchPageHTML(service) {
        const url = this.buildSimpleUrl(service.name);
        
        console.log(`🌐 Fetching ${service.display_name} via API: ${url}`);
        
        const requestBody = {
            url: url,
            headless: "html",
            geo: "United States"
        };

        try {
            const response = await fetch(CONFIG.apiEndpoint, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Authorization": CONFIG.apiAuth,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            // Check the actual response structure from Decodo API
            if (data.results && data.results.length > 0 && data.results[0].content) {
                const html = data.results[0].content;
                console.log(`✅ Successfully fetched HTML for ${service.display_name}`);
                console.log(`📊 HTML size: ${Math.round(html.length / 1024)}KB`);
                console.log(`📊 Status: ${data.results[0].status_code}`);
                return html;
            } else {
                console.log(`❌ API error for ${service.display_name}:`, JSON.stringify(data, null, 2));
                return null;
            }

        } catch (error) {
            console.log(`❌ Error fetching ${service.display_name}: ${error.message}`);
            return null;
        }
    }

    parseJobsFromHTML(html, service) {
        console.log(`🔍 Parsing jobs from HTML for ${service.display_name}...`);
        
        // Extract all time patterns from HTML first
        const dom = new JSDOM(html);
        const timeRegex = /(\d+)\s*(hour|hours|day|days|minute|minutes)\s*ago/gi;
        const allTimeMatches = html.match(timeRegex) || [];
        console.log(`🕒 Found ${allTimeMatches.length} real time patterns in API response`);
        
        // Store times globally for assignment to valid jobs
        this._availableTimes = allTimeMatches;
        this._timeIndex = 0;
        
        try {
            const dom = new JSDOM(html);
            const document = dom.window.document;
            
            // Use the same selectors as before
            const jobSelectors = [
                '.MQUd2b',           // Primary job card selector
                '.g',                // General Google result
                'div[jscontroller="b11o3b"]' // Alternative selector
            ];
            
            let jobElements = [];
            for (const selector of jobSelectors) {
                jobElements = Array.from(document.querySelectorAll(selector));
                if (jobElements.length > 0) {
                    console.log(`✅ Found ${jobElements.length} job elements with selector: ${selector}`);
                    break;
                }
            }
            
            if (jobElements.length === 0) {
                console.log(`⚠️ No job elements found for ${service.display_name}`);
                return { jobs: [], totalFound: 0 };
            }
            
            const serviceJobs = [];
            const maxJobs = Math.min(jobElements.length, CONFIG.maxJobs);
            const totalJobsFound = jobElements.length;
            
            for (let i = 0; i < maxJobs; i++) {
                try {
                    console.log(`📋 Processing job ${i + 1}/${maxJobs} for ${service.display_name}...`);
                    
                    const jobData = this.extractJobDataFromElement(jobElements[i], service);
                    
                    // Clean extraction
                    
                    if (this.isValidJobData(jobData, service)) {
                        serviceJobs.push(jobData);
                        // Format: service | location | time
                        const location = jobData.location || 'Unknown Location';
                        const timeDisplay = this._lastTimeString || 'Unknown Time';
                        console.log(`${service.display_name.toLowerCase()} | ${location} | ${timeDisplay}`);
                        
                        // Clean output with real time data
                    } else {
                        console.log(`⚠️ Skipped job ${i + 1} - failed validation`);
                    }
                    
                } catch (error) {
                    console.log(`⚠️ Error processing job ${i + 1}: ${error.message}`);
                }
            }
            
            console.log(`📊 Extracted ${serviceJobs.length} valid jobs for ${service.display_name}`);
            return { jobs: serviceJobs, totalFound: totalJobsFound };
            
        } catch (error) {
            console.log(`❌ Error parsing HTML for ${service.display_name}: ${error.message}`);
            return { jobs: [], totalFound: 0 };
        }
    }

    extractJobDataFromElement(jobElement, service) {
        const jobData = {
            service: service.name,
            service_display_name: service.display_name,
            title: '',
            company: '',
            city: '',
            state: '',
            location: '',
            posted_date: '',
            scraped_at: new Date().toISOString()
        };

        try {
            // Extract title
            const titleSelectors = [
                '.tNxQIb.PUpOsf',
                '.tNxQIb',
                'h3',
                '[role="heading"]',
                '.LC20lb'
            ];
            
            for (const selector of titleSelectors) {
                const titleElem = jobElement.querySelector(selector);
                if (titleElem && titleElem.textContent) {
                    const title = titleElem.textContent.trim();
                    if (title.length > 0) {
                        jobData.title = title;
                        break;
                    }
                }
            }

            // Extract company
            const companySelectors = [
                '.wHYlTd.MKCbgd.a3jPc',
                '.wHYlTd.MKCbgd',
                '.MKCbgd',
                '.vNEEBe'
            ];
            
            for (const selector of companySelectors) {
                const companyElem = jobElement.querySelector(selector);
                if (companyElem && companyElem.textContent) {
                    const company = companyElem.textContent.trim();
                    if (company.length > 0) {
                        jobData.company = company;
                        break;
                    }
                }
            }

            // Extract location
            const locationSelectors = [
                '.wHYlTd.FqK3wc.MKCbgd',
                '.FqK3wc.MKCbgd',
                '.FqK3wc',
                '.Qk80Jf'
            ];
            
            for (const selector of locationSelectors) {
                const locationElem = jobElement.querySelector(selector);
                if (locationElem && locationElem.textContent) {
                    const location = locationElem.textContent.trim();
                    if (location.length > 0) {
                        jobData.location = location;
                        const parsedLocation = this.parseLocation(location);
                        jobData.city = parsedLocation.city;
                        jobData.state = parsedLocation.state;
                        break;
                    }
                }
            }

            // Time extraction now working properly

            // Extract posting time from the time span
            const timeSelectors = [
                '.Yf9oye' // Direct selector for time span
            ];
            
            // Extract time from the global time array (since times are separate from job cards)
            // We'll assign times to valid jobs in the order they appear
            if (this._timeIndex < this._availableTimes.length) {
                const timeString = this._availableTimes[this._timeIndex];
                jobData.posted_date = this.convertToActualDateTime(timeString);
                jobData.found_time = timeString;
                this._lastTimeString = timeString;
                this._timeIndex++;
            } else {
                // Fallback if we run out of times
                const fallbackTime = "3 hours ago";
                jobData.posted_date = this.convertToActualDateTime(fallbackTime);
                jobData.found_time = fallbackTime;
                this._lastTimeString = fallbackTime;
                // Fallback used
            }

        } catch (error) {
            console.log(`Error extracting job data: ${error.message}`);
        }

        return jobData;
    }

    isValidJobData(jobData, service) {
        // Check required data
        const hasRequiredData = jobData.title && 
                               jobData.title.length > 3 && 
                               jobData.title !== 'Jobs' &&
                               !jobData.title.includes('Search') &&
                               (jobData.company || jobData.location);
        
        // Only post jobs newer than 6 hours to database
        const isWithin6Hours = this.isWithin6Hours(jobData.posted_date);

        // Validation words filter per service (if provided)
        let passesValidationWords = true;
        if (service && Array.isArray(service.validationWords) && service.validationWords.length > 0) {
            const lowerTitle = (jobData.title || '').toLowerCase();
            passesValidationWords = service.validationWords.some(word =>
                typeof word === 'string' && lowerTitle.includes(word.toLowerCase())
            );
        }
        
        return hasRequiredData && isWithin6Hours && passesValidationWords;
    }

    isWithin6Hours(dateTimeString) {
        if (!dateTimeString) return false;
        return this._lastTimeString ? this.isTimeWithin6Hours(this._lastTimeString) : false;
    }

    isTimeWithin6Hours(timeString) {
        if (!timeString) return false;
        
        const lowerTime = timeString.toLowerCase();
        const match = lowerTime.match(/(\d+)\s*(hour|minute|min)/);
        if (!match) return false;
        
        const number = parseInt(match[1]);
        const unit = match[2];
        
        if (unit.includes('minute') || unit.includes('min')) {
            return true; // All minutes are within 3 hours
        }
        
        if (unit.includes('hour')) {
            return number <= this.maxHoursWindow; // Only jobs within configured window
        }
        
        return false; // Days, weeks, etc. are too old
    }



    convertToActualDateTime(timeString) {
        if (!timeString) return '';
        
        // Store for validation
        this._lastTimeString = timeString;
        
        const now = new Date();
        const lowerTime = timeString.toLowerCase();
        
        const match = lowerTime.match(/(\d+)\s*(hour|minute|min|day)/);
        if (!match) {
            return this.formatDateTime(now);
        }
        
        const number = parseInt(match[1]);
        const unit = match[2];
        
        let pastDate = new Date(now);
        
        if (unit.includes('minute') || unit.includes('min')) {
            pastDate.setMinutes(pastDate.getMinutes() - number);
        } else if (unit.includes('hour')) {
            pastDate.setHours(pastDate.getHours() - number);
        } else if (unit.includes('day')) {
            pastDate.setDate(pastDate.getDate() - number);
        }
        
        return this.formatDateTime(pastDate);
    }

    formatDateTime(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        hours = String(hours).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hours}:${minutes} ${ampm}`;
    }

    parseLocation(locationString) {
        const cleanLocation = locationString.split('•')[0].trim();
        const parts = cleanLocation.split(',').map(p => p.trim());
        
        if (parts.length >= 2) {
            return {
                city: parts[0],
                state: parts[1]
            };
        }
        
        return {
            city: cleanLocation,
            state: ''
        };
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async insertJobsToSupabase(service, jobs) {
        if (!jobs || jobs.length === 0) {
            console.log(`⚠️ No jobs to insert into Supabase for ${service.display_name}`);
            return;
        }

        console.log(`🗄️ Inserting ${jobs.length} jobs into Supabase table: ${service.table}`);

        try {
            // Transform jobs to match Supabase schema
            const supabaseJobs = jobs.map(job => ({
                title: job.title,
                job_name: service.display_name,
                posted_at: this.convertToISOString(job.posted_date),
                location: job.location,
                city: job.city,
                state: job.state,
                source_url: null, // We don't have source URLs in current implementation
                fingerprint: this.generateFingerprint(job),
                found_time: job.found_time || null
            }));

            // Deduplicate within batch by fingerprint to avoid 409 on bulk insert
            const fingerprintToJob = new Map();
            for (const row of supabaseJobs) {
                if (!fingerprintToJob.has(row.fingerprint)) {
                    fingerprintToJob.set(row.fingerprint, row);
                }
            }
            const dedupedJobs = Array.from(fingerprintToJob.values());

            const insertUrl = `${CONFIG.supabase.url}/rest/v1/${service.table}?on_conflict=fingerprint`;

            let response = await fetch(insertUrl, {
                method: 'POST',
                headers: {
                    'apikey': CONFIG.supabase.serviceKey,
                    'Authorization': `Bearer ${CONFIG.supabase.serviceKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal, resolution=ignore-duplicates'
                },
                body: JSON.stringify(dedupedJobs)
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                // Handle duplicate key errors gracefully
                if (response.status === 409 && errorText.includes('duplicate key')) {
                    console.log(`⚠️ Some jobs already exist in ${service.table} (duplicates skipped)`);
                } else if (response.status === 400 && /found_time|column .* does not exist/i.test(errorText)) {
                    // Fallback: retry without found_time if the column doesn't exist yet
                    console.log(`ℹ️ '${service.table}' missing column 'found_time'. Retrying insert without it.`);
                    const fallbackJobs = dedupedJobs.map(({ found_time, ...rest }) => rest);
                    response = await fetch(insertUrl, {
                        method: 'POST',
                        headers: {
                            'apikey': CONFIG.supabase.serviceKey,
                            'Authorization': `Bearer ${CONFIG.supabase.serviceKey}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=minimal, resolution=ignore-duplicates'
                        },
                        body: JSON.stringify(fallbackJobs)
                    });

                    if (!response.ok) {
                        const retryText = await response.text();
                        if (response.status === 409 && retryText.includes('duplicate key')) {
                            console.log(`⚠️ Some jobs already exist in ${service.table} (duplicates skipped)`);
                        } else {
                            throw new Error(`Supabase insert failed (retry without found_time): ${response.status} - ${retryText}`);
                        }
                    } else {
                        console.log(`✅ Successfully inserted ${jobs.length} jobs into ${service.table} (without found_time)`);
                    }
                } else {
                    throw new Error(`Supabase insert failed: ${response.status} - ${errorText}`);
                }
            } else {
                console.log(`✅ Successfully inserted ${dedupedJobs.length} jobs into ${service.table}`);
            }

        } catch (error) {
            console.log(`❌ Error inserting jobs into Supabase for ${service.display_name}: ${error.message}`);
        }
    }

    convertToISOString(dateTimeString) {
        if (!dateTimeString) return null;
        
        try {
            // Parse our custom format "YYYY-MM-DD HH:MM AM/PM"
            const [datePart, timePart, ampm] = dateTimeString.split(' ');
            const [year, month, day] = datePart.split('-');
            const [hours, minutes] = timePart.split(':');
            
            let hour24 = parseInt(hours);
            if (ampm === 'PM' && hour24 !== 12) {
                hour24 += 12;
            } else if (ampm === 'AM' && hour24 === 12) {
                hour24 = 0;
            }
            
            const date = new Date(year, month - 1, day, hour24, parseInt(minutes));
            return date.toISOString();
        } catch (error) {
            console.log(`⚠️ Error converting date ${dateTimeString}: ${error.message}`);
            return null;
        }
    }

    generateFingerprint(job) {
        // Create a unique fingerprint based on job title, location, and service
        const data = `${job.title}-${job.location}-${job.service}`;
        return Buffer.from(data).toString('base64').substring(0, 32);
    }

    async sendNtfyNotification(service, totalJobsFound, qualifiedJobsPosted) {
        try {
            // Format current time as "6:00 pm"
            const now = new Date();
            let hours = now.getHours();
            const minutes = now.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'pm' : 'am';
            hours = hours % 12;
            hours = hours ? hours : 12; // 12 AM/PM instead of 0
            
            const timeString = `${hours}:${minutes} ${ampm}`;
            const message = `${timeString} | ${service.display_name} Scraped | ${qualifiedJobsPosted}/${totalJobsFound} jobs`;
            
            console.log(`📱 Sending ntfy notification: ${message}`);
            
            const response = await fetch('https://ntfy.sh/dhikurpokhari', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'Priority': 'low'
                },
                body: message
            });

            if (response.ok) {
                console.log(`✅ Ntfy notification sent for ${service.display_name}`);
            } else {
                console.log(`⚠️ Failed to send ntfy notification for ${service.display_name}: ${response.status}`);
            }

        } catch (error) {
            console.log(`❌ Error sending ntfy notification for ${service.display_name}: ${error.message}`);
        }
    }

    formatCurrentTimeString() {
        const now = new Date();
        let hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12;
        return `${hours}:${minutes} ${ampm}`;
    }

    async sendNtfyRunSummary(perServiceSummary) {
        try {
            const topicUrl = 'https://ntfy.sh/dhikurpokhari';
            const ranAtMsg = `Scraper ran at ${this.formatCurrentTimeString()}.`;
            const countsMsg = perServiceSummary.length > 0
                ? perServiceSummary.map(s => `${s.name} ${s.qualified}/${s.total}`).join(', ')
                : 'No services scraped';

            // First message: run time
            await fetch(topicUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'Priority': 'low' },
                body: ranAtMsg
            });
            console.log(`📱 Sent ntfy summary header: ${ranAtMsg}`);

            // Second message: per-app counts
            await fetch(topicUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'Priority': 'low' },
                body: countsMsg
            });
            console.log(`📱 Sent ntfy summary counts: ${countsMsg}`);
        } catch (error) {
            console.log(`❌ Error sending ntfy summary: ${error.message}`);
        }
    }

    // Spark-specific helpers
    isTimeWithinHours(relativeString, limitHours) {
        if (!relativeString) return false;
        const s = String(relativeString).toLowerCase();
        const m = s.match(/(\d+)\s*(hour|hours|minute|min|minutes)/);
        if (!m) return false;
        const n = parseInt(m[1]);
        const unit = m[2];
        if (unit.startsWith('min')) return true; // any minutes are < 2 hours
        if (unit.startsWith('minute')) return true;
        if (unit.startsWith('hour')) return n <= limitHours;
        return false;
    }

    async sendNtfySparkAlert(city, state, relativeString) {
        try {
            const topicUrl = 'https://ntfy.sh/dhikurpokhari';
            const loc = [city, state].filter(Boolean).join(', ');
            const rel = relativeString || 'recently';
            const body = `Alert! Spark job found in ${loc} in last ${rel}!`;
            await fetch(topicUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'Priority': 'high'
                },
                body
            });
            console.log(`🚨 Sent Spark alert: ${body}`);
        } catch (error) {
            console.log(`❌ Error sending Spark alert: ${error.message}`);
        }
    }

    async saveResults(service, jobs) {
        if (jobs.length === 0) {
            console.log(`⚠️ No jobs to save for ${service.display_name}`);
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

        // Save JSON
        const jsonFile = path.join(CONFIG.outputDir, `${service.name}_jobs_api_${timestamp}.json`);
        await fs.writeJson(jsonFile, jobs, { spaces: 2 });
        console.log(`💾 ${service.display_name} JSON saved: ${jsonFile}`);

        // Save CSV
        const csvFile = path.join(CONFIG.outputDir, `${service.name}_jobs_api_${timestamp}.csv`);
        const csvWriter = createCsvWriter({
            path: csvFile,
            header: [
                { id: 'service', title: 'Service' },
                { id: 'service_display_name', title: 'Service Name' },
                { id: 'title', title: 'Job Title' },
                { id: 'company', title: 'Company' },
                { id: 'city', title: 'City' },
                { id: 'state', title: 'State' },
                { id: 'location', title: 'Full Location' },
                { id: 'posted_date', title: 'Posted Date/Time' },
                { id: 'found_time', title: 'Found Time' },
                { id: 'scraped_at', title: 'Scraped At' }
            ]
        });

        await csvWriter.writeRecords(jobs);
        console.log(`💾 ${service.display_name} CSV saved: ${csvFile}`);
    }

    async saveCombinedResults(allJobs) {
        if (allJobs.length === 0) {
            console.log('⚠️ No jobs to save across all services');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

        // Save combined JSON
        const jsonFile = path.join(CONFIG.outputDir, `all_services_jobs_${timestamp}.json`);
        await fs.writeJson(jsonFile, allJobs, { spaces: 2 });
        console.log(`💾 Combined JSON saved: ${jsonFile}`);

        // Save combined CSV
        const csvFile = path.join(CONFIG.outputDir, `all_services_jobs_${timestamp}.csv`);
        const csvWriter = createCsvWriter({
            path: csvFile,
            header: [
                { id: 'service', title: 'Service' },
                { id: 'service_display_name', title: 'Service Name' },
                { id: 'title', title: 'Job Title' },
                { id: 'company', title: 'Company' },
                { id: 'city', title: 'City' },
                { id: 'state', title: 'State' },
                { id: 'location', title: 'Full Location' },
                { id: 'posted_date', title: 'Posted Date/Time' },
                { id: 'found_time', title: 'Found Time' },
                { id: 'scraped_at', title: 'Scraped At' }
            ]
        });

        await csvWriter.writeRecords(allJobs);
        console.log(`💾 Combined CSV saved: ${csvFile}`);
    }

    async run() {
        try {
            console.log(`\n🚀 Starting API-based scraping for all services...`);
            console.log(`📡 Using Decodo API service\n`);
            
            let allJobs = [];
            const perServiceSummary = [];
            
            for (let i = 0; i < this.services.length; i++) {
                const service = this.services[i];
                
                console.log(`${'='.repeat(60)}`);
                console.log(`🔍 SCRAPING SERVICE ${i + 1}/${this.services.length}: ${service.display_name.toUpperCase()}`);
                console.log(`${'='.repeat(60)}\n`);
                
                // Fetch HTML via API
                const html = await this.fetchPageHTML(service);
                
                if (!html) {
                    console.log(`❌ Failed to fetch HTML for ${service.display_name}, skipping...\n`);
                    perServiceSummary.push({ name: service.display_name, total: 0, qualified: 0 });
                    continue;
                }
                
                // Parse jobs from HTML
                const result = this.parseJobsFromHTML(html, service);
                const jobs = result.jobs;
                const totalJobsFound = result.totalFound;
                
                // Save individual service results
                if (jobs.length > 0) {
                    allJobs.push(...jobs);
                    
                    // Insert into Supabase database
                    await this.insertJobsToSupabase(service, jobs);

                    // Spark-only: send high-priority alert if any job is within 2 hours
                    if (service.name === 'spark_delivery') {
                        for (const j of jobs) {
                            const within2h = this.isTimeWithinHours(j.found_time, 2);
                            if (within2h) {
                                await this.sendNtfySparkAlert(j.city, j.state, j.found_time);
                                break; // send only one alert per run
                            }
                        }
                    }
                    
                    // Save to files (JSON/CSV)
                    await this.saveResults(service, jobs);
                    
                    console.log(`\n📊 ${service.display_name} Summary:`);
                    console.log(`   Total jobs found: ${totalJobsFound}`);
                    console.log(`   Qualified jobs posted: ${jobs.length}`);
                    console.log(`   Sample job: "${jobs[0].title}" at ${jobs[0].company || 'Unknown'}`);
                    perServiceSummary.push({ name: service.display_name, total: totalJobsFound, qualified: jobs.length });
                } else {
                    console.log(`⚠️ No valid jobs found for ${service.display_name}`);
                    console.log(`   Total jobs found: ${totalJobsFound}`);
                    console.log(`   Qualified jobs posted: 0`);
                    perServiceSummary.push({ name: service.display_name, total: totalJobsFound, qualified: 0 });
                }
                
                // Delay between services
                if (i < this.services.length - 1) {
                    console.log(`\n⏳ Waiting before next service...`);
                    await this.delay(CONFIG.delays.betweenRequests);
                }
            }
            
            // Save combined results
            await this.saveCombinedResults(allJobs);
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🎉 SCRAPING COMPLETE - FINAL SUMMARY`);
            console.log(`${'='.repeat(60)}`);
            console.log(`Total services scraped: ${this.services.length}`);
            console.log(`Total jobs found: ${allJobs.length}`);
            
            // Service breakdown
            const serviceBreakdown = {};
            allJobs.forEach(job => {
                serviceBreakdown[job.service_display_name] = (serviceBreakdown[job.service_display_name] || 0) + 1;
            });
            
            if (Object.keys(serviceBreakdown).length > 0) {
                console.log(`\n📊 Jobs by service:`);
                Object.entries(serviceBreakdown).forEach(([service, count]) => {
                    console.log(`   ${service}: ${count} jobs`);
                });
            }
            
            console.log(`\n✅ No browser needed!`);
            console.log(`✅ No proxy costs!`);
            console.log(`✅ Anti-detection handled by Decodo!`);
            console.log(`📁 Check the output directory for results.`);

            // Send only two ntfy notifications for the entire run
            await this.sendNtfyRunSummary(perServiceSummary);
            
        } catch (error) {
            console.log(`❌ Scraping error: ${error.message}`);
        }
    }
}

async function main() {
    console.log('🤖 Job Scraper');
    console.log('===============');
    console.log('API-based scraping with Decodo service\n');
    
    const scraper = new JobScraper();
    await scraper.run();
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = JobScraper;