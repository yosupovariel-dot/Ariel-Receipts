// הגדרות כלליות של המערכת
export const CONFIG = {
  // מאגר GitHub שבו נשמר קובץ הנתונים המוצפן
  owner: 'yosupovariel-dot',
  repo: 'Ariel-Receipts',
  // ענף לשמירת הנתונים. null = הענף הראשי (default branch) של המאגר
  branch: null,
  dataPath: 'data/receipts.enc.json',

  // משתמשים מורשים (הסיסמה עצמה לא נשמרת בקוד — היא משמשת כמפתח הצפנה)
  usernames: ['אריאל', 'ariel'],

  // ניתוק אוטומטי אחרי חוסר פעילות (דקות)
  idleMinutes: 30,

  // הגנה מפני ניחוש סיסמה
  maxAttempts: 5,
  lockSeconds: 60,
};
