FROM node:22-alpine3.19

# Install the required packages
RUN npm Install

# Copy the source code to the container
COPY ./app.ts /app

# Set the working directory
WORKDIR /app

# Run the application
CMD ["npm", "run", "start"]