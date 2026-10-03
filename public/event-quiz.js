// FBLA Competitive Event Recommendation Quiz.
// The questions are the chapter's own (plus a grade question, because the
// "Introduction to" events are for 9th and 10th graders only). The event table
// was built from the 2026-27 PA FBLA competitive event guidelines: format, team
// size, pre-judged parts and grade limits come straight from each guide.
// Used by the public hub (window.EventQuiz) and by the tests (require()).
(function (root) {
  const QUESTIONS = [
    { id: 'grade', text: 'What grade are you in?', options: [['9', '9th'], ['10', '10th'], ['11', '11th'], ['12', '12th']] },
    { id: 'q1', text: 'When working on a project, which do you usually prefer?', options: [['alone', 'Working by myself'], ['pair', 'Working with one other person'], ['team', 'Working with a small team'], ['none', "I don't really have a preference"]] },
    { id: 'q2', text: 'How comfortable are you speaking in front of other people?', options: [['2', 'Very comfortable'], ['1', 'Somewhat comfortable'], ['-1', 'A little uncomfortable'], ['-2', 'Very uncomfortable']] },
    { id: 'q3', text: 'How do you feel about giving a formal presentation?', options: [['2', 'I enjoy it'], ['1', "I'm comfortable with it"], ['-0.5', "I can do it, but it's not my favorite"], ['-2', "I'd rather avoid it"]] },
    { id: 'q4', text: "How comfortable are you thinking on your feet when you don't have much time to prepare?", options: [['2', 'Very comfortable'], ['1', 'Pretty comfortable'], ['-1', 'Somewhat uncomfortable'], ['-2', 'Very uncomfortable']] },
    { id: 'q5', text: 'Which type of work do you enjoy most?', options: [['analyze', 'Analyzing information and finding solutions'], ['write', 'Writing and communicating ideas'], ['create', 'Creating and presenting something'], ['num', 'Working with numbers and data'], ['people', 'Working with other people'], ['mix', 'A mix of these']] },
    { id: 'q6', text: 'How do you feel about taking tests?', options: [['2', 'I usually enjoy them and do well'], ['1', "I don't mind them"], ['-0.5', "They aren't my favorite, but I can do well with preparation"], ['-2', "I'd rather demonstrate my knowledge another way"]] },
    { id: 'q7', text: 'How strong would you consider your writing skills?', options: [['2', 'One of my strongest skills'], ['1', 'Pretty strong'], ['0', 'Average'], ['-1.5', 'Not one of my strengths']] },
    { id: 'q8', text: 'How strong would you consider your public speaking skills?', options: [['2', 'One of my strongest skills'], ['1', 'Pretty strong'], ['0', 'Average'], ['-1.5', 'Not one of my strengths']] },
    { id: 'q9', text: 'How comfortable are you working with numbers, calculations, or financial information?', options: [['2', 'Very comfortable'], ['1', 'Somewhat comfortable'], ['0', 'I can handle it with practice'], ['-2', "I'd rather avoid it"]] },
    { id: 'q10', text: "How much do you enjoy solving problems where there isn't an obvious answer?", options: [['2', 'A lot'], ['1', 'Somewhat'], ['-0.5', 'Not much'], ['-1.5', 'Not at all']] },
    { id: 'q11', text: 'Which sounds most interesting to you?', options: [['business', 'Starting or running a business'], ['marketing', 'Marketing or advertising'], ['finance', 'Finance or accounting'], ['management', 'Management or leadership'], ['tech', 'Technology or information systems'], ['hospitality', 'Hospitality or tourism'], ['healthcare', 'Healthcare'], ['other', 'Something else']] },
    { id: 'q12', text: 'When learning something new, which approach works best for you?', options: [['read', 'Reading and studying information'], ['practice', 'Practicing questions'], ['hands', 'Doing something hands-on'], ['discuss', 'Discussing it with other people'], ['create', 'Creating or presenting something']] },
    { id: 'q13', text: 'How do you usually handle working under a time limit?', options: [['pressure', 'I perform better under pressure'], ['focused', 'I can usually stay focused'], ['struggle', 'I sometimes struggle with time pressure'], ['time', 'I prefer having plenty of time to prepare']] },
    { id: 'q14', text: 'How comfortable are you being evaluated by a judge or other person?', options: [['2', 'Very comfortable'], ['1', 'Somewhat comfortable'], ['-1', 'A little uncomfortable'], ['-2', 'Very uncomfortable']] },
    { id: 'q15', text: 'Which would you rather do?', options: [['test', 'Study material and demonstrate my knowledge on a test'], ['present', 'Prepare a presentation ahead of time'], ['scenario', 'Receive a scenario and respond on the spot'], ['team', 'Work with a partner or team'], ['open', "I'm open to any of these"]] },
    { id: 'q16', text: 'How much preparation are you realistically willing to put into a competitive event?', options: [['3', 'I am willing to put in a lot of time'], ['2.5', 'I can consistently dedicate several hours a week'], ['1.5', 'I can prepare regularly, but my schedule is busy'], ['1', 'I would prefer an event with a lighter preparation commitment']] },
    { id: 'q17', text: 'What do you think is one of your biggest strengths?', options: [['communication', 'Communication'], ['creativity', 'Creativity'], ['leadership', 'Leadership'], ['organization', 'Organization'], ['problem', 'Problem-solving'], ['memorization', 'Memorization/studying'], ['others', 'Working with others'], ['independent', 'Working independently']] },
    { id: 'q18', text: 'What are you most hoping to get out of competing in FBLA?', options: [['speaking', 'Improve my public speaking'], ['knowledge', 'Build business knowledge'], ['leadership', 'Develop leadership skills'], ['challenge', 'Challenge myself'], ['career', 'Gain experience for college/career'], ['compete', 'Compete and try to advance as far as possible'], ['meet', 'Meet and work with other FBLA members'], ['unsure', "I'm not sure yet"]] },
  ];

  // fmt: test | production | roleplay | presentation | speech | impromptu | interview | chapter
  // team: i = individual, t3 = team of 1, 2 or 3, t45 = team of 4 or 5
  // skills 0-3: how much the event leans on each; prep 1-3: light to heavy
  // flags: intro (9th/10th only), pj (pre-judged written asset), test (has an
  // objective test besides its main format), career, hard
  const EVENTS = [
    {"name":"Accounting","fmt":"test","team":"i","areas":["finance"],"skills":{"num":3,"analyze":1},"prep":1,"desc":"Accounting challenges competitors to demonstrate their understanding of fundamental accounting principles through an objective test."},
    {"name":"Advanced Accounting","fmt":"test","team":"i","areas":["finance"],"skills":{"num":3,"analyze":2},"prep":2,"hard":1,"desc":"Advanced Accounting allows members to demonstrate their knowledge of higher-level accounting concepts through an objective test."},
    {"name":"Advertising","fmt":"test","team":"i","areas":["marketing"],"skills":{"create":1,"write":1},"prep":1,"desc":"Advertising challenges members to demonstrate their understanding of advertising principles and strategies through an objective test."},
    {"name":"Agribusiness","fmt":"test","team":"i","areas":["business","other"],"skills":{"analyze":1},"prep":1,"desc":"Agribusiness allows members to demonstrate their understanding of business principles as they apply to the agriculture industry through an objective test."},
    {"name":"Business Communication","fmt":"test","team":"i","areas":["other"],"skills":{"write":3},"prep":1,"desc":"Business Communication challenges members to demonstrate their knowledge of effective communication practices in the workplace through an objective test."},
    {"name":"Business Law","fmt":"test","team":"i","areas":["other"],"skills":{"analyze":2,"write":1},"prep":1,"desc":"Business Law challenges members to demonstrate their understanding of the legal system and its impact on business operations through an objective test."},
    {"name":"Computer Problem Solving","fmt":"test","team":"i","areas":["tech"],"skills":{"tech":3,"analyze":2},"prep":1,"desc":"Computer Problem Solving challenges members to demonstrate their understanding of computer systems, including operating systems, networking, and hardware, through an objective test."},
    {"name":"Cybersecurity","fmt":"test","team":"i","areas":["tech"],"skills":{"tech":3,"analyze":1},"prep":1,"desc":"Cybersecurity challenges members to demonstrate their knowledge of protecting systems and data from digital threats such as viruses, malware, phishing, and spyware."},
    {"name":"Data Science & AI","fmt":"test","team":"i","areas":["tech"],"skills":{"tech":2,"num":2,"analyze":3},"prep":1,"hard":1,"desc":"Data Science & AI challenges members to demonstrate their understanding of data analysis, machine learning, and the principles of artificial intelligence through an objective test."},
    {"name":"Economics","fmt":"test","team":"i","areas":["finance","other"],"skills":{"num":2,"analyze":2},"prep":1,"desc":"Economics challenges members to demonstrate their understanding of key economic concepts and principles through an objective test."},
    {"name":"Healthcare Administration","fmt":"test","team":"i","areas":["healthcare"],"skills":{"org":1},"prep":1,"desc":"Healthcare Administration challenges members to demonstrate their knowledge of medical terminology, office procedures, and administrative functions within a healthcare setting."},
    {"name":"Human Resource Management","fmt":"test","team":"i","areas":["management"],"skills":{"people":2,"lead":1},"prep":1,"desc":"Human Resource Management challenges members to demonstrate their understanding of key HR functions, including staffing, training, employee relations, and performance management."},
    {"name":"Insurance & Risk Management","fmt":"test","team":"i","areas":["finance"],"skills":{"num":1,"analyze":1},"prep":1,"desc":"Insurance & Risk Management challenges members to demonstrate their understanding of risk management principles and various types of insurance."},
    {"name":"Journalism","fmt":"test","team":"i","areas":["other"],"skills":{"write":3},"prep":1,"desc":"Journalism challenges members to demonstrate their knowledge of journalistic principles, media ethics, and the business of news through an objective test."},
    {"name":"Networking Infrastructures","fmt":"test","team":"i","areas":["tech"],"skills":{"tech":3},"prep":1,"desc":"Networking Infrastructures challenges members to demonstrate their knowledge of network administration and infrastructure through an objective test."},
    {"name":"Organizational Leadership","fmt":"test","team":"i","areas":["management"],"skills":{"lead":3,"people":1},"prep":1,"desc":"Organizational Leadership challenges members to demonstrate their understanding of leadership principles within a business context through an objective test."},
    {"name":"Personal Finance","fmt":"test","team":"i","areas":["finance"],"skills":{"num":2},"prep":1,"desc":"Personal Finance challenges members to demonstrate their understanding of essential financial skills through an objective test."},
    {"name":"Project Management","fmt":"test","team":"i","areas":["management"],"skills":{"org":3,"lead":1},"prep":1,"desc":"Project Management challenges members to demonstrate their understanding of key project management concepts through an objective test."},
    {"name":"Public Administration & Management","fmt":"test","team":"i","areas":["management","other"],"skills":{"analyze":1},"prep":1,"desc":"Public Administration & Management challenges members to demonstrate their understanding of how government functions and its role in society through an objective test."},
    {"name":"Real Estate","fmt":"test","team":"i","areas":["finance","business"],"skills":{"num":1},"prep":1,"desc":"Real Estate challenges members to demonstrate their understanding of the real estate industry through an objective test."},
    {"name":"Retail Management","fmt":"test","team":"i","areas":["marketing","business"],"skills":{"org":1},"prep":1,"desc":"Retail Management challenges high school members to demonstrate their understanding of core retail operations and strategies through an objective test."},
    {"name":"Securities & Investments","fmt":"test","team":"i","areas":["finance"],"skills":{"num":2,"analyze":2},"prep":1,"desc":"Securities & Investments challenges members to demonstrate their understanding of investment principles and financial markets through an objective test."},
    {"name":"Introduction to Business Communication","fmt":"test","team":"i","areas":["other"],"skills":{"write":2},"prep":1,"intro":1,"desc":"Introduction to Business Communication challenges members to demonstrate their understanding of fundamental communication skills in a business setting through an objective test."},
    {"name":"Introduction to Business Concepts","fmt":"test","team":"i","areas":["business","management"],"skills":{},"prep":1,"intro":1,"desc":"Introduction to Business Concepts allows members to demonstrate their knowledge of foundational business principles through an objective test."},
    {"name":"Introduction to Business Procedures","fmt":"test","team":"i","areas":["management","other"],"skills":{"org":2},"prep":1,"intro":1,"desc":"Introduction to Business Procedures challenges members to demonstrate their understanding of basic office procedures and workplace practices through an objective test."},
    {"name":"Introduction to FBLA","fmt":"test","team":"i","areas":["other"],"skills":{"lead":1},"prep":1,"intro":1,"desc":"Introduction to FBLA allows members to demonstrate their knowledge of the organization’s history, structure, programs, and leadership through an objective test."},
    {"name":"Introduction to Information Technology","fmt":"test","team":"i","areas":["tech"],"skills":{"tech":2},"prep":1,"intro":1,"desc":"Introduction to Information Technology challenges members to demonstrate their understanding of fundamental IT concepts through an objective test."},
    {"name":"Introduction to Marketing Concepts","fmt":"test","team":"i","areas":["marketing"],"skills":{},"prep":1,"intro":1,"desc":"Introduction to Marketing Concepts allows members to demonstrate their understanding of foundational marketing principles through an objective test."},
    {"name":"Introduction to Parliamentary Procedure","fmt":"test","team":"i","areas":["management","other"],"skills":{"lead":1},"prep":1,"intro":1,"desc":"Introduction to Parliamentary Procedure challenges members to demonstrate their understanding of the basic principles and rules used to conduct orderly and effective meetings."},
    {"name":"Introduction to Retail & Merchandising","fmt":"test","team":"i","areas":["marketing","business"],"skills":{},"prep":1,"intro":1,"desc":"Introduction to Retail & Merchandising challenges members to demonstrate their understanding of basic principles in retail operations and merchandising strategies through an objective test."},
    {"name":"Introduction to Supply Chain Management","fmt":"test","team":"i","areas":["management","business"],"skills":{"analyze":1},"prep":1,"intro":1,"desc":"Introduction to Supply Chain Management challenges members to demonstrate their understanding of the processes involved in the flow of goods, information, and finances within a supply chain."},
    {"name":"Computer Applications","fmt":"production","team":"i","areas":["tech"],"skills":{"tech":2,"org":2},"prep":2,"desc":"Computer Applications challenges members to demonstrate their proficiency in using a variety of software applications to manage and communicate business information."},
    {"name":"Banking & Financial Systems","fmt":"roleplay","team":"t3","areas":["finance"],"skills":{"num":1,"analyze":2,"speak":2},"prep":2,"desc":"Banking & Financial Systems challenges members to demonstrate their understanding of how financial institutions function and their impact on both business and personal finance."},
    {"name":"Business Management","fmt":"roleplay","team":"t3","areas":["management","business"],"skills":{"lead":2,"analyze":2,"speak":2},"prep":2,"desc":"Business Management challenges members to demonstrate their understanding of core management principles through an objective test and a role play scenario."},
    {"name":"Customer Service","fmt":"roleplay","team":"i","areas":["other","hospitality"],"skills":{"people":3,"speak":2},"prep":2,"desc":"Customer Service allows members to demonstrate their ability to deliver exceptional service in a professional setting."},
    {"name":"Entrepreneurship","fmt":"roleplay","team":"t3","areas":["business"],"skills":{"analyze":2,"create":1,"speak":2},"prep":2,"desc":"Entrepreneurship challenges members to demonstrate their knowledge of what it takes to start and manage a successful business."},
    {"name":"Hospitality & Event Management","fmt":"roleplay","team":"t3","areas":["hospitality"],"skills":{"org":2,"people":2,"speak":2},"prep":2,"desc":"Hospitality & Event Management challenges members to demonstrate their understanding of the hospitality industry and event planning through an objective test and a role play scenario."},
    {"name":"International Business","fmt":"roleplay","team":"t3","areas":["business","management","marketing"],"skills":{"analyze":2,"speak":2},"prep":2,"desc":"International Business gives members the opportunity to explore the dynamic global economy and understand how businesses operate across borders."},
    {"name":"Management Information Systems","fmt":"roleplay","team":"t3","areas":["tech","management"],"skills":{"tech":2,"analyze":2,"speak":2},"prep":2,"desc":"Management Information Systems challenges members to apply their knowledge of how businesses use technology to manage information and support decision-making."},
    {"name":"Marketing","fmt":"roleplay","team":"t3","areas":["marketing"],"skills":{"create":1,"analyze":1,"speak":2},"prep":2,"desc":"Marketing challenges members to demonstrate their understanding of marketing concepts and strategies through an objective test and a role play scenario."},
    {"name":"Network Design","fmt":"roleplay","team":"t3","areas":["tech"],"skills":{"tech":3,"analyze":2,"speak":2},"prep":2,"desc":"Network Design challenges members to demonstrate their understanding of networking concepts and infrastructure through an objective test and a role play scenario."},
    {"name":"Sports & Entertainment Management","fmt":"roleplay","team":"t3","areas":["marketing","hospitality","management"],"skills":{"analyze":1,"speak":2},"prep":2,"desc":"Sports & Entertainment Management challenges members to demonstrate their understanding of the business aspects of the sports and entertainment industries."},
    {"name":"Technology Support & Services","fmt":"roleplay","team":"i","areas":["tech"],"skills":{"tech":2,"people":2,"speak":2},"prep":2,"desc":"Technology Support & Services challenges members to demonstrate their knowledge of help desk operations and IT support through an objective test and a role play scenario."},
    {"name":"Parliamentary Procedure","fmt":"roleplay","team":"t45","areas":["management","other"],"skills":{"lead":3,"people":3,"speak":2},"prep":3,"desc":"Parliamentary Procedure allows members to demonstrate their understanding of the principles and practices used to conduct orderly and efficient meetings."},
    {"name":"Broadcast Journalism","fmt":"presentation","team":"t3","areas":["other"],"skills":{"write":2,"create":2,"speak":3},"prep":3,"desc":"Broadcast Journalism challenges members to showcase their communication, storytelling, and production skills by creating and delivering a professional news broadcast."},
    {"name":"Business Ethics","fmt":"presentation","team":"t3","areas":["other","management"],"skills":{"write":2,"analyze":2,"speak":2},"prep":3,"test":1,"pj":1,"desc":"Business Ethics recognizes members who can analyze and present solutions to ethical dilemmas commonly faced in the business world."},
    {"name":"Business Plan","fmt":"presentation","team":"t3","areas":["business"],"skills":{"write":3,"num":2,"analyze":2,"speak":2},"prep":3,"pj":1,"hard":1,"desc":"Business Plan gives members the opportunity to develop and present a comprehensive plan for launching a new business."},
    {"name":"Coding & Programming","fmt":"presentation","team":"t3","areas":["tech"],"skills":{"tech":3,"analyze":2,"create":1,"speak":1},"prep":3,"hard":1,"desc":"Coding & Programming challenges members to design and develop a standalone application that solves a specific problem or accomplishes a defined task."},
    {"name":"Computer Game & Simulation Programming","fmt":"presentation","team":"t3","areas":["tech"],"skills":{"tech":3,"create":3,"speak":1},"prep":3,"hard":1,"desc":"Computer Game & Simulation Programming gives members the opportunity to design and develop an interactive game or simulation based on a specific topic."},
    {"name":"Data Analysis","fmt":"presentation","team":"t3","areas":["tech","finance"],"skills":{"num":3,"analyze":3,"speak":2},"prep":2,"desc":"Data Analysis challenges members to examine and interpret a data set to uncover insights and inform decision-making."},
    {"name":"Digital Animation","fmt":"presentation","team":"t3","areas":["tech","marketing"],"skills":{"create":3,"tech":2,"speak":1},"prep":3,"pj":1,"desc":"Digital Animation allows members to design and present an original animated video that demonstrates creativity, storytelling, and technical skill."},
    {"name":"Digital Video Production","fmt":"presentation","team":"t3","areas":["marketing","tech"],"skills":{"create":3,"tech":1,"speak":1},"prep":3,"pj":1,"desc":"Digital Video Production recognizes members who demonstrate the ability to plan, produce, and present a compelling video tailored to a specific audience."},
    {"name":"Event Planning","fmt":"presentation","team":"t3","areas":["hospitality"],"skills":{"org":3,"create":1,"num":1,"speak":2},"prep":3,"desc":"Event Planning allows members to demonstrate their knowledge of the event planning industry by developing and presenting a plan for a real event."},
    {"name":"Financial Planning","fmt":"presentation","team":"t3","areas":["finance"],"skills":{"num":3,"analyze":2,"speak":2},"prep":2,"desc":"Financial Planning challenges members to apply personal finance knowledge by analyzing a family scenario and developing a plan to help them meet their financial goals."},
    {"name":"Financial Statement Analysis","fmt":"presentation","team":"t3","areas":["finance"],"skills":{"num":3,"analyze":3,"speak":2},"prep":2,"hard":1,"desc":"Financial Statement Analysis allows members to apply their knowledge of accounting principles to interpret and evaluate financial information."},
    {"name":"Graphic Design","fmt":"presentation","team":"t3","areas":["tech","marketing"],"skills":{"create":3,"tech":1,"speak":1},"prep":2,"desc":"Graphic Design allows members to showcase their creativity and technical skills by developing original visual content."},
    {"name":"Introduction to Business Presentation","fmt":"presentation","team":"t3","areas":["business"],"skills":{"create":1,"speak":2},"prep":2,"intro":1,"desc":"Introduction to Business Presentation gives members the opportunity to develop and deliver a business-focused presentation using presentation software as a visual aid."},
    {"name":"Introduction to Programming","fmt":"presentation","team":"t3","areas":["tech"],"skills":{"tech":2,"analyze":1,"speak":1},"prep":2,"intro":1,"desc":"Introduction to Programming allows members to design and develop a basic computer program based on a given topic."},
    {"name":"Introduction to Social Media Strategy","fmt":"presentation","team":"t3","areas":["marketing"],"skills":{"create":2,"speak":2},"prep":2,"intro":1,"desc":"Introduction to Social Media Strategy allows members to develop and present a marketing strategy centered around a single social media platform."},
    {"name":"Mobile Application Development","fmt":"presentation","team":"t3","areas":["tech"],"skills":{"tech":3,"create":2,"speak":1},"prep":3,"hard":1,"desc":"Mobile Application Development allows members to design and develop a functional mobile app based on a given topic."},
    {"name":"Public Service Announcement","fmt":"presentation","team":"t3","areas":["marketing","other"],"skills":{"create":3,"speak":1},"prep":2,"desc":"Public Service Announcement (PSA) gives members the opportunity to create a 60-second video that raises awareness about a specific issue."},
    {"name":"Sales Presentation","fmt":"presentation","team":"t3","areas":["marketing","business"],"skills":{"speak":3,"people":2},"prep":2,"desc":"Sales Presentation allows members to showcase their ability to effectively sell a product or service of their choice."},
    {"name":"Social Media Strategies","fmt":"presentation","team":"t3","areas":["marketing"],"skills":{"create":2,"analyze":1,"speak":2},"prep":2,"desc":"Social Media Strategies allows members to develop and present a comprehensive marketing campaign using multiple social media platforms."},
    {"name":"Supply Chain Management","fmt":"presentation","team":"t3","areas":["management","business"],"skills":{"analyze":2,"speak":2},"prep":2,"desc":"Supply Chain Management challenges members to apply their understanding of how goods, information, and finances move through a supply chain."},
    {"name":"Visual Design","fmt":"presentation","team":"t3","areas":["tech","marketing"],"skills":{"create":3,"speak":1},"prep":2,"desc":"Visual Design allows members to showcase their creativity and technical skills by developing original visual content."},
    {"name":"Website Coding & Development","fmt":"presentation","team":"t3","areas":["tech"],"skills":{"tech":3,"analyze":1,"speak":1},"prep":3,"hard":1,"desc":"Website Coding & Development challenges members to design and build a website based on a specific topic, with a primary focus on backend coding and functionality."},
    {"name":"Website Design","fmt":"presentation","team":"t3","areas":["tech","marketing"],"skills":{"create":3,"tech":2,"speak":1},"prep":3,"desc":"Website Design allows members to create a visually engaging and user-friendly website based on a specific topic."},
    {"name":"Public Speaking","fmt":"speech","team":"i","areas":["other"],"skills":{"speak":3,"write":2},"prep":2,"desc":"Public Speaking allows members to develop and deliver a well-structured speech on a designated topic."},
    {"name":"Introduction to Public Speaking","fmt":"speech","team":"i","areas":["other"],"skills":{"speak":3,"write":1},"prep":2,"intro":1,"desc":"Introduction to Public Speaking gives members the opportunity to develop and deliver a speech on a designated topic."},
    {"name":"Impromptu Speaking","fmt":"impromptu","team":"i","areas":["other"],"skills":{"speak":3,"analyze":1},"prep":1,"desc":"Impromptu Speaking challenges members to think quickly and deliver a well-organized, engaging speech on a topic revealed onsite at the competition."},
    {"name":"Job Interview","fmt":"interview","team":"i","areas":["other"],"skills":{"speak":2,"write":1,"people":1},"prep":2,"pj":1,"career":1,"desc":"Job Interview challenges members to develop professional job application materials and demonstrate effective interviewing skills."},
    {"name":"Career Portfolio","fmt":"presentation","team":"i","areas":["other"],"skills":{"write":2,"speak":2,"org":1},"prep":2,"career":1,"desc":"Career Portfolio gives members the opportunity to showcase their accomplishments, skills, and career goals in a professional portfolio format."},
    {"name":"Future Business Leader","fmt":"interview","team":"i","areas":["management","other"],"skills":{"lead":3,"speak":2,"write":1},"prep":3,"test":1,"pj":1,"career":1,"hard":1,"desc":"Future Business Leader is FBLA’s premier event recognizing members who exemplify leadership, business knowledge, and active involvement in the organization."},
    {"name":"Future Business Educator","fmt":"presentation","team":"i","areas":["other"],"skills":{"speak":2,"write":2,"create":1},"prep":2,"pj":1,"career":1,"desc":"Future Business Educator gives competitors the opportunity to explore a career in business education by demonstrating their knowledge, instructional planning, and presentation skills."},
    {"name":"American Enterprise Project","fmt":"chapter","team":"t3","areas":["business","finance"],"skills":{"write":2,"lead":1,"speak":2},"prep":3,"pj":1,"desc":"American Enterprise Project provides chapter members with the opportunity to showcase their understanding of the economic system under which they live and to develop a concept in which they share it with their community."},
    {"name":"Community Service Project","fmt":"chapter","team":"t3","areas":["other"],"skills":{"lead":2,"people":2,"org":2,"speak":2},"prep":3,"pj":1,"desc":"Community Service Project gives chapter members the opportunity to showcase a service initiative that addresses a need within their school or local community."},
    {"name":"Local Chapter Annual Business Report","fmt":"chapter","team":"t3","areas":["management","other"],"skills":{"write":2,"org":2,"lead":2,"speak":2},"prep":3,"pj":1,"desc":"Local Chapter Annual Business Report gives chapter members the opportunity to document and present their Program of Work and accomplishments from the year."},
    {"name":"Partnership with Business Project","fmt":"chapter","team":"t3","areas":["business"],"skills":{"people":2,"lead":2,"speak":2},"prep":3,"pj":1,"desc":"Partnership with Business Project provides chapter members with the opportunity to share their chapter’s development and implementation of an innovative, creative, and effective partnership with a business to benefit the greater good."},
  ];

  const AREA_LABEL = { business: 'starting or running a business', marketing: 'marketing and advertising', finance: 'finance and accounting', management: 'management and leadership', tech: 'technology and information systems', hospitality: 'hospitality and tourism', healthcare: 'healthcare' };
  const FORMAT_LABEL = { test: 'Objective test', production: 'Production test (hands-on, on a computer)', roleplay: 'Objective test + role play', presentation: 'Prepared presentation', speech: 'Prepared speech', impromptu: 'Speech on a topic given on-site', interview: 'Interview', chapter: 'Chapter project: report + presentation' };
  const TEAM_LABEL = { i: 'Individual', t3: 'Individual or team of 2-3', t45: 'Team of 4-5' };
  const SPOT = { roleplay: 1, impromptu: 1, interview: 1 };
  const PREPARED = { presentation: 1, speech: 1, chapter: 1 };
  const hasTest = (e) => e.fmt === 'test' || e.fmt === 'roleplay' || !!e.test;

  function formatLine(e) {
    let f = FORMAT_LABEL[e.fmt];
    if (e.fmt === 'presentation' && e.test) f = 'Objective test + written report + presentation';
    else if (e.fmt === 'interview' && e.test) f = 'Application materials + objective test + interview';
    else if (e.fmt === 'interview') f = 'Application materials + interview';
    else if (e.pj && e.fmt === 'presentation') f = 'Pre-judged entry + presentation';
    return `${TEAM_LABEL[e.team]} · ${f}`;
  }

  // Turn answers into a profile of numbers (roughly -2..+2).
  function profile(a) {
    const n = (id) => Number(a[id]) || 0;
    const p = {
      speak: (n('q2') + n('q3') + n('q8') + n('q14')) / 4,
      spot: n('q4') + ({ pressure: 0.5, focused: 0.2, struggle: -0.5, time: -0.8 }[a.q13] || 0),
      test: n('q6') + ({ read: 0.5, practice: 0.7 }[a.q12] || 0) + (a.q17 === 'memorization' ? 0.8 : 0),
      write: n('q7') + (a.q5 === 'write' ? 1 : 0),
      num: n('q9') + (a.q5 === 'num' ? 1 : 0),
      analyze: n('q10') + (a.q5 === 'analyze' ? 1 : 0) + (a.q17 === 'problem' ? 0.8 : 0),
      create: (a.q5 === 'create' ? 1 : 0) + (a.q17 === 'creativity' ? 1.5 : 0) + (a.q12 === 'create' || a.q12 === 'hands' ? 0.5 : 0),
      people: (a.q5 === 'people' ? 1 : 0) + (a.q17 === 'others' ? 1 : 0) + (a.q12 === 'discuss' ? 0.5 : 0) + (a.q18 === 'meet' ? 0.5 : 0),
      lead: (a.q17 === 'leadership' ? 1.5 : 0) + (a.q18 === 'leadership' ? 1.5 : 0),
      org: a.q17 === 'organization' ? 1.5 : 0,
      prep: Number(a.q16) || 2,
    };
    return p;
  }

  // Score one event. Every contribution carries the reason shown to the member.
  function scoreEvent(e, a, p) {
    const parts = [];
    const add = (pts, why) => { if (pts) parts.push({ pts, why }); };
    // Interests
    if (a.q11 && a.q11 !== 'other' && e.areas.includes(a.q11)) add(e.areas[0] === a.q11 ? 4 : 3, `It fits your interest in ${AREA_LABEL[a.q11]}.`);
    if (a.q11 === 'other' && e.areas.includes('other')) add(2.5, 'You picked "Something else", and this event is outside the usual business areas.');
    // Technical events need real technical skills; don't push them on someone
    // who didn't pick technology or hands-on work.
    if ((e.skills.tech || 0) >= 2 && a.q11 !== 'tech' && a.q12 !== 'hands') add(-1.5, 'It needs real technical (computer) skills.');
    // Tests
    if (hasTest(e)) add((e.fmt === 'test' ? 1.6 : 0.8) * p.test, p.test > 0 ? (e.fmt === 'test' ? 'It is a test event, and tests suit you.' : 'It includes an objective test, which suits you.') : (e.fmt === 'test' ? "It's only a test, and you'd rather show what you know another way." : 'It includes an objective test.'));
    // Speaking in front of judges
    const speakDemand = e.skills.speak || 0;
    if (speakDemand) add(0.9 * speakDemand * p.speak, p.speak > 0 ? 'It puts your speaking and presenting in front of judges to use.' : 'It means speaking in front of judges, which you said is uncomfortable.');
    else if (p.speak < 0) add(-0.7 * p.speak, 'There is no speaking in front of judges.');
    // On the spot vs. prepared ahead
    if (SPOT[e.fmt]) add(1.2 * p.spot, p.spot > 0 ? 'You respond on the spot, and you think well on your feet.' : 'You have to respond on the spot with little prep time.');
    if (PREPARED[e.fmt]) add(p.spot < 0 ? -0.5 * p.spot : 0, 'You prepare it ahead of time instead of responding on the spot.');
    // Q15: what they'd rather do
    if (a.q15 === 'test') add(e.fmt === 'test' || e.fmt === 'production' ? 2.5 : (hasTest(e) ? 0.8 : 0), 'You said you would rather study and show it on a test.');
    if (a.q15 === 'present') add(PREPARED[e.fmt] ? 2.5 : 0, 'You said you would rather prepare a presentation ahead of time.');
    if (a.q15 === 'scenario') add(SPOT[e.fmt] ? 2.5 : 0, 'You said you would rather get a scenario and respond on the spot.');
    if (a.q15 === 'team') add(e.team !== 'i' ? 2 : 0, 'You said you would rather work with a partner or team.');
    // Q12: how they learn
    if ((a.q12 === 'read' || a.q12 === 'practice') && e.fmt === 'test') add(1, 'You learn by studying and practicing questions, which is how you prepare for a test.');
    if (a.q12 === 'hands' && (e.fmt === 'production' || ((e.skills.tech || 0) >= 2 && e.fmt !== 'test') || (e.skills.create || 0) >= 3)) add(1, 'It is hands-on: you build or make something.');
    if (a.q12 === 'discuss' && (e.fmt === 'roleplay' || e.team !== 'i')) add(0.8, 'It involves talking ideas through with others.');
    if (a.q12 === 'create' && PREPARED[e.fmt]) add(1, 'You learn by creating and presenting, which is what this event is.');
    // Q13: time limits
    if (a.q13 === 'pressure' && (e.fmt === 'test' || e.fmt === 'production' || SPOT[e.fmt])) add(0.8, 'It is timed, and you do well under pressure.');
    if ((a.q13 === 'time' || a.q13 === 'struggle') && (PREPARED[e.fmt] || e.pj)) add(1, 'Most of the work happens ahead of time, not under a clock.');
    if ((a.q13 === 'time' || a.q13 === 'struggle') && e.fmt === 'impromptu') add(-1.5, 'The topic is given on-site with only minutes to prepare.');
    if ((a.q13 === 'time' || a.q13 === 'struggle') && e.fmt === 'roleplay') add(-0.6, 'The role play gives you only a short prep time.');
    // Skills
    for (const [k, w, good, bad] of [
      ['write', 0.5, 'It rewards strong writing.', 'It needs a lot of writing.'],
      ['num', 0.6, 'It uses numbers and financial information, which you are comfortable with.', 'It is heavy on numbers and calculations.'],
      ['analyze', 0.4, 'It is about working through problems without an obvious answer.', 'It involves open-ended problem solving.'],
      ['create', 0.5, 'It lets you be creative.', null],
      ['people', 0.4, 'It is about working with people.', null],
      ['lead', 0.5, 'It builds on leadership.', null],
      ['org', 0.5, 'It rewards being organized.', null],
    ]) {
      const demand = e.skills[k] || 0;
      if (!demand || !p[k]) continue;
      const pts = w * demand * p[k];
      if (pts > 0 || bad) add(pts, pts > 0 ? good : bad);
    }
    // Team size
    if (a.q1 === 'alone') add({ i: 1.5, t3: 0, t45: -3 }[e.team], e.team === 'i' ? 'You compete on your own.' : e.team === 't45' ? 'It needs a team of 4 or 5.' : '');
    if (a.q1 === 'pair') add({ i: -1, t3: 1.5, t45: -1.5 }[e.team], e.team === 't3' ? 'You can enter with one partner.' : e.team === 'i' ? 'It is individual only.' : 'It needs a team of 4 or 5.');
    if (a.q1 === 'team') add({ i: -1, t3: 1.5, t45: 2 }[e.team], e.team === 'i' ? 'It is individual only.' : 'You compete as a small team.');
    if (a.q17 === 'independent') add(e.team === 'i' ? 1 : 0, 'You work well independently, and this is an individual event.');
    if (a.q17 === 'others') add(e.team !== 'i' ? 1 : 0, 'You work well with others, and this is a team event.');
    // Preparation time
    if (e.prep > p.prep) add(-2 * (e.prep - p.prep), e.prep === 3 ? 'It takes a lot of preparation (building, writing or rehearsing ahead of time).' : 'It takes more preparation than you said you have time for.');
    else if (p.prep <= 1.5 && e.prep === 1) add(1, 'It fits a lighter preparation schedule.');
    // Strengths and goals
    if (a.q17 === 'communication') add(speakDemand ? 0.6 * speakDemand : 0, 'It plays to your communication skills.');
    if (a.q17 === 'memorization') add(e.fmt === 'test' ? 1 : 0, 'Studying and memorizing is exactly how you prepare for it.');
    if (a.q18 === 'speaking') add(speakDemand ? 0.8 * speakDemand : 0, 'It will build your public speaking.');
    if (a.q18 === 'knowledge') add(hasTest(e) ? 1 : 0, 'Studying for it builds business knowledge.');
    if (a.q18 === 'leadership') add(e.fmt === 'chapter' ? 0.5 : 0, 'It is a chapter leadership project.');
    if (a.q18 === 'challenge') add(e.hard ? 1.2 : 0, "It's one of the more demanding events.");
    if (a.q18 === 'career') add(e.career ? 2 : 0, 'It is built around college and career readiness.');
    if (a.q18 === 'meet') add(e.team !== 'i' ? 1.2 : 0, 'You compete with other members.');
    // Grade eligibility (9th and 10th only) and chapter projects
    if (e.intro) add(a.grade === '9' || a.grade === '10' ? 1.5 : 0, 'It is designed for 9th and 10th graders.');
    if (e.fmt === 'chapter') add(-1, '');
    const score = parts.reduce((s, x) => s + x.pts, 0);
    const reasons = parts.filter(x => x.pts > 0.4 && x.why).sort((x, y) => y.pts - x.pts).map(x => x.why);
    const cautions = parts.filter(x => x.pts < -0.4 && x.why).sort((x, y) => x.pts - y.pts).map(x => x.why);
    return { score, reasons: [...new Set(reasons)].slice(0, 3), cautions: [...new Set(cautions)].slice(0, 1) };
  }

  function recommend(answers) {
    const p = profile(answers);
    const upper = answers.grade === '11' || answers.grade === '12';
    return EVENTS
      .filter(e => !(e.intro && upper)) // "Introduction to" events: 9th and 10th graders only
      .map(e => ({ event: e, format: formatLine(e), ...scoreEvent(e, answers, p) }))
      .sort((x, y) => y.score - x.score || x.event.name.localeCompare(y.event.name));
  }

  const api = { QUESTIONS, EVENTS, recommend, formatLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EventQuiz = api;
})(typeof window !== 'undefined' ? window : this);
