import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';
import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';
import { useEnvironment } from './EnvironmentContext';

const TasksSettingsContext = createContext({
  tasksEnabled: true,
  setTasksEnabled: () => {},
  toggleTasksEnabled: () => {},
  isTaskMasterInstalled: null,
  isTaskMasterReady: null,
  installationStatus: null,
  isCheckingInstallation: true
});

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};

export const TasksSettingsProvider = ({ children }) => {
  const { targetKey } = useEnvironment();

  const [tasksEnabled, setTasksEnabled] = useState(() => {
    // Load from localStorage on initialization
    const saved = localStorage.getItem('tasks-enabled');
    return saved !== null ? JSON.parse(saved) : true; // Default to true
  });
  
  const [isTaskMasterInstalled, setIsTaskMasterInstalled] = useState(null);
  const [isTaskMasterReady, setIsTaskMasterReady] = useState(null);
  const [installationStatus, setInstallationStatus] = useState(null);
  const [isCheckingInstallation, setIsCheckingInstallation] = useState(true);

  // Save to localStorage whenever tasksEnabled changes
  useEffect(() => {
    localStorage.setItem('tasks-enabled', JSON.stringify(tasksEnabled));
  }, [tasksEnabled]);

  // 随当前目标（本机 / remote:id）重新探测：安装态与 Web 终端是否带 PATH 无关，此前仅 mount 一次会切远端后仍显示本机结果。
  useEffect(() => {
    const checkInstallation = async () => {
      // Skip if no auth token - user is not logged in
      const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
      if (!token) {
        setIsTaskMasterInstalled(false);
        setIsTaskMasterReady(false);
        setIsCheckingInstallation(false);
        return;
      }

      setIsCheckingInstallation(true);

      try {
        const response = await api.get('/taskmaster/installation-status');
        if (response.ok) {
          const data = await response.json();
          setInstallationStatus(data);
          setIsTaskMasterInstalled(data.installation?.isInstalled || false);
          setIsTaskMasterReady(data.isReady || false);

          // If TaskMaster is not installed and user hasn't explicitly enabled tasks,
          // disable tasks automatically
          const userEnabledTasks = localStorage.getItem('tasks-enabled');
          if (!data.installation?.isInstalled && !userEnabledTasks) {
            setTasksEnabled(false);
          }
        } else if (response.status === 401) {
          // Silently ignore 401 - user is not logged in
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        } else {
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        }
      } catch (error) {
        setIsTaskMasterInstalled(false);
        setIsTaskMasterReady(false);
      } finally {
        setIsCheckingInstallation(false);
      }
    };

    void checkInstallation();
  }, [targetKey]);

  const toggleTasksEnabled = () => {
    setTasksEnabled(prev => !prev);
  };

  const contextValue = {
    tasksEnabled,
    setTasksEnabled,
    toggleTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    installationStatus,
    isCheckingInstallation
  };

  return (
    <TasksSettingsContext.Provider value={contextValue}>
      {children}
    </TasksSettingsContext.Provider>
  );
};

export default TasksSettingsContext;