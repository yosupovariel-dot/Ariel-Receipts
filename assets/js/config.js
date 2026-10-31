// הגדרות כלליות של המערכת
export const CONFIG = {
  // כתובת ה-Web app של Google Apps Script (מסתיימת ב-/exec). אם ריק — נשמרת בכל מכשיר בנפרד
  driveUrl: 'https://script.google.com/macros/s/AKfycbwWgMHOuCpuFdS7vroFl_6dMJguAX4mwFl5NO-UOBOtvliT9CpBxmoJoCVsuGHvFO3AHQ/exec',

  // קובץ נתונים התחלתי (ריק ומוצפן) — משמש רק בפעם הראשונה, לפני שיש נתונים ב-Drive
  seedPath: 'data/receipts.enc.json',

  // קוד המקור (לקישורים)
  owner: 'yosupovariel-dot',
  repo: 'Ariel-Receipts',

  // משתמשים מורשים (הסיסמה עצמה לא נשמרת בקוד — היא משמשת כמפתח הצפנה)
  usernames: ['אריאל', 'ariel'],

  // ניתוק אוטומטי אחרי חוסר פעילות (דקות)
  idleMinutes: 30,

  // הגנה מפני ניחוש סיסמה
  maxAttempts: 5,
  lockSeconds: 60,
};
