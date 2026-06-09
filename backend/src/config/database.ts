import { Sequelize } from 'sequelize';

const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'longdcam',
  process.env.MYSQL_USER || 'longdcam',
  process.env.MYSQL_PASSWORD || 'longdcam1234',
  {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'production' ? false : console.log,
    pool: {
      min: 5,
      max: 20,
      acquire: 30000,
      idle: 10000,
    },
  }
);

export default sequelize;
