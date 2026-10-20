// PA FBLA 2026-27 Competitive Events Zoom sessions (Derek Selleck, PA FBLA
// Competitive Events Coordinator). Open to advisers and students; registration
// required. Loaded into Study & Prep > Links from the officer portal
// (Study & Prep tab > "Load the PA FBLA Zoom session links"); links already
// there are skipped, so loading twice adds nothing.
const GROUP = 'Competitive Events Zoom Sessions';
const zoom = (id) => `https://us02web.zoom.us/meeting/register/${id}`;
// Each event session runs about 30 minutes and covers only the events named.
const event = (title, when, id) => ({ title, url: zoom(id), competitive_event: GROUP, description: when });
module.exports = [
  { title: '2026-27 Competitive Events Changes for PA', url: zoom('KH0eDU1KSSKWEQqoxiJ--w'), competitive_event: GROUP,
    description: 'Sep 30 · 4:00 PM · Every 2026-27 event change, with Derek Selleck (PA FBLA). For advisers and members' },
  event('Objective Test Only Events', 'Oct 1 · 7:00 PM', 'OqB6e_TzTb2NHrcxDC7q6A'),
  event('Objective Tests with Role Plays', 'Oct 1 · 7:45 PM', '4eVxwHVSTkWImFEmLMF-zA'),
  event('Computer Applications', 'Oct 1 · 8:30 PM', 'NNEklDHJRq-7WarJM2zzbQ'),
  event('Digital Video Production / Digital Animation', 'Oct 5 · 7:00 PM', 'lKnDdln1TRKQnhCZk9gHvQ'),
  event('Business Plan', 'Oct 5 · 7:45 PM', 'GThveoApRh6GTu9g0MFrrw'),
  event('Website Design / Website Coding and Development', 'Oct 5 · 8:30 PM', '8vrxkUajR26E3bOy5N2NFg'),
  event('Coding & Programming / Introduction to Programming / Computer Game & Simulation Programming / Mobile Application Development', 'Oct 19 · 7:00 PM', '6Wsui0dvRPeeUjehrWBLaw'),
  event('Future Business Educator', 'Oct 19 · 7:45 PM', 'NA8RblMURjOTYq5cCZR72A'),
  event('Data Analysis / Financial Statement Analysis', 'Oct 19 · 8:30 PM', 'W3SL6IcHSuCsgw2DO8_S-Q'),
  event('Career Portfolio', 'Oct 22 · 7:00 PM', 'XbeVjDeJRZeXRBvy5rQLeA'),
  event('Broadcast Journalism', 'Oct 22 · 7:45 PM', '58tM-41MR2yFPMWXbIYH-w'),
  event('Business Ethics', 'Oct 22 · 8:30 PM', 'YEHDtZ_BRrGc-1uWCc-V5A'),
  event('Impromptu Speaking', 'Oct 26 · 7:00 PM', 'HyHSGceUQuObTVSB3l43FA'),
  event('Public Service Announcement', 'Oct 26 · 7:45 PM', 'jTC1TRLzQRC0PZlXl4PC3g'),
  event('Job Interview', 'Oct 26 · 8:30 PM', 'cjVJP3yCQeCoxSJfqfdD9Q'),
  event('Introduction to Public Speaking / Public Speaking', 'Oct 27 · 7:00 PM', 'I22k2n2kT9mDGY94yp3giw'),
  event('Introduction to Social Media Strategy / Social Media Strategies', 'Oct 27 · 7:45 PM', 'kawBSe78REWDy8P_Pa-yuQ'),
  event('Future Business Leader', 'Oct 27 · 8:30 PM', '_cENt9-dQc-IRtOYZmpeQA'),
  event('Sales Presentation', 'Nov 5 · 7:00 PM', 'uBiRw2QNSaOxw0nSatuMtg'),
  event('Introduction to Business Presentation', 'Nov 5 · 7:45 PM', 'VsEvmps3TmaBfkhJl7J10A'),
  event('Graphic Design / Visual Design', 'Nov 5 · 8:30 PM', 'i1gRSfYwSXi8IIz1G5gNJQ'),
  event('Event Planning / Financial Planning', 'Nov 9 · 7:00 PM', 'mau53gi7SPaZNuFv2_pwPg'),
  event('Supply Chain Management', 'Nov 9 · 7:45 PM', 'qKB8homESIu6wnUSxhi0oQ'),
  event('American Enterprise Project / Community Service Project / Local Chapter Annual Business Report / Partnership with Business', 'Nov 9 · 8:30 PM', 'MjnnwO7rSGK9znqwaMyQHw'),
];
